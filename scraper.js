
const puppeteer = require('puppeteer');
const axios = require('axios');

// CONFIG
const FIREBASE_SECRET = 'JbXhB8D2qIXuQyRoNZIArvX9Q6vqUGA7HunILgBl'; 
const DATABASE_URL = 'https://arc-radar-default-rtdb.firebaseio.com/events.json';
const REFRESH_INTERVAL_MINUTES = 60; 
const TARGET_URL = 'https://metaforge.app/arc-raiders/event-timers';

const KNOWN_MAPS = ['Buried City', 'Dam Battlegrounds', 'Dam', 'The Spaceport', 'Spaceport', 'Blue Gate', 'Stella Montis'];
const KNOWN_EVENTS = ['Night Raid', 'Electromagnetic Storm', 'Matriarch', 'Harvester', 'Hidden Bunker', 'Husk Graveyard', 'Prospecting Probes', 'Uncovered Caches', 'Standard Patrol', 'Lush Blooms', 'Inquisitor'];

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
        const scrapedData = await page.evaluate((knownMaps, knownEvents) => {
            const results = [];
            const divs = Array.from(document.querySelectorAll('div'));
            
            // Find cards containing "Upcoming windows"
            const eventCards = divs.filter(div => {
                const text = div.innerText || "";
                return knownEvents.some(e => text.includes(e)) && 
                       text.toLowerCase().includes('upcoming windows') &&
                       text.length < 3000; 
            });

            const processedTexts = new Set();

            eventCards.forEach(card => {
                const fullText = card.innerText;
                if (processedTexts.has(fullText)) return;
                processedTexts.add(fullText);

                // Split Header from Table
                const parts = fullText.split(/Upcoming windows/i);
                if (parts.length < 2) return;

                const headerSection = parts[0];
                const tableText = parts[1];

                // Identify Event Type
                const headerUpper = headerSection.toUpperCase();
                const eventType = knownEvents.find(e => headerUpper.includes(e.toUpperCase())) || "Unknown";

                // Extract Window String just for display (don't use for math)
                const windowMatch = headerSection.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
                const windowStr = windowMatch ? windowMatch[0] : null;

                // --- CRITICAL: Relative Time Extraction ---
                // Looks for "ENDS IN 58m", "STARTS IN 2h 10m", "Ends in: 5m"
                let headerDurationSeconds = 0; 
                // Regex: Matches "ENDS" or "STARTS", optional "IN", optional colon, capturing the time string
                const durationMatch = headerSection.match(/(?:ENDS|STARTS)(?:\s+IN)?\s*:?\s*(.*?)(?:\n|$)/i);
                
                if (durationMatch && durationMatch[1]) {
                     const timeStr = durationMatch[1].toLowerCase();
                     let sec = 0;
                     
                     // Robust parsing for "1h 20m", "58m", "30s"
                     const h = timeStr.match(/(\d+)\s*h/);
                     const m = timeStr.match(/(\d+)\s*m/);
                     const s = timeStr.match(/(\d+)\s*s/);
                     
                     if (h) sec += parseInt(h[1]) * 3600;
                     if (m) sec += parseInt(m[1]) * 60;
                     if (s) sec += parseInt(s[1]);
                     
                     headerDurationSeconds = sec;
                }

                // Process Table Rows (Specific Maps)
                const lines = tableText.split('\n');
                let currentMap = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const foundMap = knownMaps.find(m => line.toUpperCase().includes(m.toUpperCase()));
                    if (foundMap) currentMap = foundMap;

                    if (currentMap) {
                        let status = null;
                        if (line.toLowerCase().includes('now') || line.toLowerCase().includes('active')) {
                            status = 'ACTIVE';
                        } 
                        else if (line.toLowerCase().includes('in ')) {
                            status = 'UPCOMING';
                        }

                        // Try to get specific row duration
                        let rowSeconds = 0;
                        const matchesH = line.match(/(\d+)\s*[hH]/);
                        const matchesM = line.match(/(\d+)\s*[mM]/);
                        const matchesS = line.match(/(\d+)\s*[sS]/); 
                        if (matchesH) rowSeconds += parseInt(matchesH[1]) * 3600;
                        if (matchesM) rowSeconds += parseInt(matchesM[1]) * 60;
                        if (matchesS) rowSeconds += parseInt(matchesS[1]);

                        if (status) {
                            results.push({
                                mapName: currentMap,
                                eventType: eventType,
                                status: status,
                                windowStr: windowStr, 
                                headerDuration: headerDurationSeconds,
                                rowDuration: rowSeconds
                            });
                        }
                    }
                }
            });

            return results;
        }, KNOWN_MAPS, KNOWN_EVENTS);

        console.log(`[ARC RADAR] ${scrapedData.length} eventos brutos encontrados.`);

        const enrichedEvents = scrapedData.map((evt) => {
            const now = getRealNow(); 
            let targetTimestamp = null;
            let finalWindowStr = evt.windowStr;

            // --- UNIVERSAL TIME CALCULATION ---
            // Logic: "Target Time" = "Server Now" + "Remaining Duration"
            // This creates a UTC Timestamp that is true everywhere.

            if (evt.status === 'ACTIVE') {
                // If Active, Target = When it ENDS
                if (evt.headerDuration > 0) {
                    targetTimestamp = now + (evt.headerDuration * 1000);
                } else {
                    // Fallback if regex fails: 1 hour default
                    targetTimestamp = now + 3600000;
                    if (!finalWindowStr) finalWindowStr = "LIVE NOW";
                }
            } 
            else if (evt.status === 'UPCOMING') {
                // If Upcoming, Target = When it STARTS
                
                // Row duration is usually more specific for "Upcoming" list items
                if (evt.rowDuration > 0) {
                    targetTimestamp = now + (evt.rowDuration * 1000);
                }
                // Fallback to header if row fails
                else if (evt.headerDuration > 0) {
                    targetTimestamp = now + (evt.headerDuration * 1000);
                }
                else {
                     // Fallback: 1 hour default
                     targetTimestamp = now + 3600000; 
                }
            }

            // Create a unique key for Firebase to avoid duplicates/flicker
            const uniqueKey = `${evt.eventType}-${evt.mapName}-${evt.status}-${targetTimestamp}`.replace(/[.#$/\[\]]/g, '');

            return {
                _key: uniqueKey,
                mapName: evt.mapName,
                eventType: evt.eventType,
                status: evt.status,
                targetTimestamp: targetTimestamp,
                windowStr: finalWindowStr, 
                scrapedAt: now,
                // Debug info
                durationSeconds: Math.floor((targetTimestamp - now) / 1000)
            };
        });

        // Deduplicate events (sometimes scraping picks up duplicates)
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
            
            // Legacy Auth via URL string
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
            console.error(`[ARC RADAR] Detalhes:`, JSON.stringify(error.response.data));
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
