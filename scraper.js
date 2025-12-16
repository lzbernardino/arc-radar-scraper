
const puppeteer = require('puppeteer');
const axios = require('axios');

// CONFIG
const FIREBASE_SECRET = 'JbXhB8D2qIXuQyRoNZIArvX9Q6vqUGA7HunILgBl'; 
const DATABASE_URL = 'https://arc-radar-default-rtdb.firebaseio.com/events.json';
const REFRESH_INTERVAL_MINUTES = 180; // Alterado para 3 horas (180m) conforme solicitado
const TARGET_URL = 'https://metaforge.app/arc-raiders/event-timers';

const KNOWN_MAPS = [
    'Buried City', 'Dam Battlegrounds', 'Dam', 'The Spaceport', 'Spaceport', 
    'Blue Gate', 'Stella Montis'
];

// Use System Time (Server is usually NTP synced)
function getRealNow() {
    return Date.now();
}

async function scrapeAndSave() {
    console.log(`\n[ARC RADAR] --- Iniciando Scanner: ${new Date().toLocaleTimeString('pt-BR')} ---`);
    
    const cleanSecret = FIREBASE_SECRET.trim();
    if (cleanSecret.includes('COLE_SEU') || cleanSecret.length < 10) {
        console.error('[ERRO DE SEGURANÇA] Chave do Firebase inválida no scraper.js!');
        return;
    }

    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 2500 });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        console.log(`[ARC RADAR] Acessando MetaForge...`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for dynamic content
        await new Promise(r => setTimeout(r, 5000));

        // SCRAPING LOGIC
        const scrapedData = await page.evaluate((knownMaps) => {
            const results = [];
            const divs = Array.from(document.querySelectorAll('div'));
            
            // LOGIC UPDATE: Instead of looking for specific text headers like "Upcoming windows" which might change,
            // we look for ANY container that mentions "Ends in" or "Starts in" AND contains a known Map name.
            // This is much more robust against layout changes.
            
            const eventCards = divs.filter(div => {
                const text = div.innerText || "";
                if (text.length > 2000) return false; // Ignore large containers
                if (text.length < 50) return false;   // Ignore tiny labels

                const hasTimer = /Ends\s+in|Starts\s+in|Ends:|Starts:/i.test(text);
                const hasMap = knownMaps.some(m => text.toUpperCase().includes(m.toUpperCase()));
                
                return hasTimer && hasMap;
            });

            // Use Set to avoid processing the same card multiple times (since divs are nested)
            const processedSignatures = new Set();

            eventCards.forEach(card => {
                const fullText = card.innerText;
                
                // Simple signature based on first 50 chars to dedup nested divs
                const signature = fullText.substring(0, 50);
                if (processedSignatures.has(signature)) return;
                processedSignatures.add(signature);

                // Split Header from Table (Heuristic: usually split by the timer or a new line)
                const lines = fullText.split('\n').map(l => l.trim()).filter(l => l);
                
                // Try to detect Event Name (usually first line that isn't a timer)
                let detectedName = "Unknown Event";
                for (const line of lines) {
                    if (!line.match(/Ends\s+in/i) && !line.match(/Starts\s+in/i) && !line.match(/^\d+/) && line.length > 3) {
                        detectedName = line;
                        break;
                    }
                }
                detectedName = detectedName.replace(/[:]/g, '').trim();

                // Extract Window String
                const windowMatch = fullText.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
                const windowStr = windowMatch ? windowMatch[0] : null;

                // Extract Timer Seconds
                let headerDurationSeconds = 0; 
                const durationMatch = fullText.match(/(?:ENDS|STARTS|Ends|Starts)(?:\s+IN|:)?\s*:?\s*(.*?)(?:\n|$)/i);
                
                if (durationMatch && durationMatch[1]) {
                     const timeStr = durationMatch[1].toLowerCase();
                     let sec = 0;
                     const h = timeStr.match(/(\d+)\s*h/);
                     const m = timeStr.match(/(\d+)\s*m/);
                     const s = timeStr.match(/(\d+)\s*s/);
                     if (h) sec += parseInt(h[1]) * 3600;
                     if (m) sec += parseInt(m[1]) * 60;
                     if (s) sec += parseInt(s[1]);
                     headerDurationSeconds = sec;
                }

                // Identify Map and Status
                let currentMap = null;
                let status = null;

                // Loop through lines to find specific map status
                for (const line of lines) {
                    const foundMap = knownMaps.find(m => line.toUpperCase().includes(m.toUpperCase()));
                    if (foundMap) currentMap = foundMap;

                    if (currentMap) {
                         if (line.match(/Active|Now|Live/i)) status = 'ACTIVE';
                         else if (line.match(/in\s+\d+|Upcoming/i)) status = 'UPCOMING';
                         
                         // If we found a map line, and we have a global timer from the header, we can form an event
                         if (status) {
                             // Try to find specific row timer if available, else use header timer
                             let rowSeconds = headerDurationSeconds;
                             const rowH = line.match(/(\d+)\s*[hH]/);
                             const rowM = line.match(/(\d+)\s*[mM]/);
                             if (rowH || rowM) {
                                 rowSeconds = 0;
                                 if (rowH) rowSeconds += parseInt(rowH[1]) * 3600;
                                 if (rowM) rowSeconds += parseInt(rowM[1]) * 60;
                             }

                             results.push({
                                mapName: currentMap,
                                eventType: detectedName,
                                status: status,
                                windowStr: windowStr, 
                                duration: rowSeconds
                            });
                            // Reset for next iteration in same card
                            currentMap = null; 
                            status = null;
                         }
                    }
                }
            });

            return results;
        }, KNOWN_MAPS);

        console.log(`[ARC RADAR] ${scrapedData.length} eventos brutos encontrados.`);

        const enrichedEvents = scrapedData.map((evt) => {
            const now = getRealNow(); 
            let targetTimestamp = null;
            let finalWindowStr = evt.windowStr;

            if (evt.status === 'ACTIVE') {
                if (evt.duration > 0) {
                    targetTimestamp = now + (evt.duration * 1000);
                } else {
                    targetTimestamp = now + 3600000;
                    if (!finalWindowStr) finalWindowStr = "LIVE NOW";
                }
            } 
            else if (evt.status === 'UPCOMING') {
                if (evt.duration > 0) {
                    targetTimestamp = now + (evt.duration * 1000);
                } else {
                     targetTimestamp = now + 3600000; 
                }
            }

            const uniqueKey = `${evt.eventType}-${evt.mapName}-${evt.status}-${targetTimestamp}`.replace(/[.#$/\[\]]/g, '');

            return {
                _key: uniqueKey,
                mapName: evt.mapName,
                eventType: evt.eventType,
                status: evt.status,
                targetTimestamp: targetTimestamp,
                windowStr: finalWindowStr, 
                scrapedAt: now,
                durationSeconds: Math.floor((targetTimestamp - now) / 1000)
            };
        });

        // Deduplicate events
        const uniqueEvents = [];
        const seenKeys = new Set();
        enrichedEvents.forEach(e => {
             const simpleKey = e.mapName + e.eventType + e.status;
             if (!seenKeys.has(simpleKey)) {
                 seenKeys.add(simpleKey);
                 uniqueEvents.push(e);
             }
        });

        if (uniqueEvents.length > 0) {
            console.log(`[ARC RADAR] Enviando dados para o Firebase...`);
            const finalUrl = `${DATABASE_URL}?auth=${cleanSecret}`;
            await axios.put(finalUrl, uniqueEvents, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log(`[ARC RADAR] Sucesso! ${uniqueEvents.length} eventos sincronizados.`);
        } else {
            console.log(`[ARC RADAR] Aviso: Nenhum evento extraído.`);
        }

    } catch (error) {
        if (error.response) {
            console.error(`[ARC RADAR] Erro Firebase: ${error.response.status} ${error.response.statusText}`);
        } else {
            console.error('[ARC RADAR] Erro Fatal:', error.message);
        }
    } finally {
        await browser.close();
    }
}

// Run immediately then loop
scrapeAndSave();
setInterval(scrapeAndSave, REFRESH_INTERVAL_MINUTES * 60 * 1000);
console.log(`[ARC RADAR] Serviço de Monitoramento iniciado (Intervalo: ${REFRESH_INTERVAL_MINUTES}m)`);
