
const puppeteer = require('puppeteer');
const axios = require('axios');

// CONFIG
const FIREBASE_SECRET = 'JbXhB8D2qIXuQyRoNZIArvX9Q6vqUGA7HunILgBl'; // <--- CHAVE CORRIGIDA
const DATABASE_URL = 'https://arc-radar-default-rtdb.firebaseio.com/events.json';
const REFRESH_INTERVAL_MINUTES = 60; // Check hourly (App handles interpolation)
const TARGET_URL = 'https://metaforge.app/arc-raiders/event-timers';
const TIME_API_URL = 'http://worldtimeapi.org/api/timezone/America/Sao_Paulo';

const KNOWN_MAPS = ['Buried City', 'Dam Battlegrounds', 'Dam', 'The Spaceport', 'Spaceport', 'Blue Gate', 'Stella Montis'];
const KNOWN_EVENTS = ['Night Raid', 'Electromagnetic Storm', 'Matriarch', 'Harvester', 'Hidden Bunker', 'Husk Graveyard', 'Prospecting Probes', 'Uncovered Caches', 'Standard Patrol', 'Lush Blooms', 'Inquisitor'];

// GLOBAL OFFSET (Difference between Atomic Time and Local PC Time)
let CLOCK_OFFSET = 0;

async function syncClock() {
    try {
        console.log('[CLOCK] Sincronizando com Relógio Atômico...');
        const response = await axios.get(TIME_API_URL, { timeout: 5000 });
        const atomicTime = new Date(response.data.datetime).getTime();
        const localTime = Date.now();
        
        CLOCK_OFFSET = atomicTime - localTime;
        
        console.log(`[CLOCK] Ajuste de Tempo: ${Math.round(CLOCK_OFFSET/1000)}s`);
        const correctedTime = new Date(localTime + CLOCK_OFFSET);
        console.log(`[CLOCK] Hora PC: ${new Date(localTime).toLocaleTimeString()} -> Hora Real (BRT): ${correctedTime.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    } catch (e) {
        console.error('[CLOCK] Falha ao sincronizar. Usando hora local.', e.message);
        CLOCK_OFFSET = 0;
    }
}

function getRealNow() {
    return Date.now() + CLOCK_OFFSET;
}

// Parses "11:00 - 12:00" into an absolute Timestamp, ignoring OS Timezone
function parseTimeWindowToTimestamp(windowStr, type) {
    try {
        if (!windowStr || !windowStr.includes('-')) return null;

        const parts = windowStr.split('-').map(s => s.trim());
        const timeStr = type === 'END' ? parts[1] : parts[0];
        const [h, m] = timeStr.split(':');

        const now = getRealNow();
        
        // 1. Get current YYYY-MM-DD in Sao Paulo explicitly
        const fmt = new Intl.DateTimeFormat('en-CA', { // en-CA returns YYYY-MM-DD format
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const ymd = fmt.format(new Date(now)); // e.g. "2023-10-27"

        // 2. Construct ISO String with fixed -03:00 offset for Sao Paulo
        // This bypasses the Windows System Timezone completely
        const isoString = `${ymd}T${h.padStart(2,'0')}:${m.padStart(2,'0')}:00-03:00`;
        
        let targetTs = new Date(isoString).getTime();

        // 3. Handle Day Rollover
        // If target time (e.g. 00:10) is much smaller than now (e.g. 23:50), it means it's tomorrow
        // Threshold: 12 hours ago
        if (targetTs < now - (12 * 3600 * 1000)) {
            targetTs += 24 * 3600 * 1000; // Add 24h
        }
        // If type is START and it looks like it's in the past but shouldn't be (not strictly needed for windows logic but good safety)
        
        return targetTs;

    } catch (e) {
        console.log("Error parsing window:", e.message);
        return null;
    }
}

async function scrapeAndSave() {
    await syncClock(); 

    console.log(`\n[ARC RADAR] --- Iniciando Scanner: ${new Date(getRealNow()).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ---`);
    
    // Check key format
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
        // Viewport large enough to load all cards without scrolling issues
        await page.setViewport({ width: 1440, height: 2500 });
        
        // Set User Agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        console.log(`[ARC RADAR] Acessando MetaForge...`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for hydration
        await new Promise(r => setTimeout(r, 5000));

        // SCRAPING LOGIC
        const scrapedData = await page.evaluate((knownMaps, knownEvents) => {
            const results = [];
            const divs = Array.from(document.querySelectorAll('div'));
            
            // Find event cards by looking for container divs that have "Upcoming windows" text
            const eventCards = divs.filter(div => {
                const text = div.innerText || "";
                return knownEvents.some(e => text.includes(e)) && 
                       text.toLowerCase().includes('upcoming windows') &&
                       text.length < 3000; // Limit length to avoid grabbing the whole body
            });

            const processedTexts = new Set();

            eventCards.forEach(card => {
                const fullText = card.innerText;
                
                // Deduplicate: inner divs might be caught, check if we already processed this text block
                if (processedTexts.has(fullText)) return;
                processedTexts.add(fullText);

                // --- HEADER PARSING ---
                // We split by "Upcoming windows" to isolate the header
                const parts = fullText.split(/Upcoming windows/i);
                if (parts.length < 2) return;

                const headerSection = parts[0];
                const tableText = parts[1];

                // Identify Event Type
                const headerUpper = headerSection.toUpperCase();
                const eventType = knownEvents.find(e => headerUpper.includes(e.toUpperCase())) || "Unknown";

                // Extract Window (e.g. 10:00 - 11:00) from header
                // This is crucial for precise timing
                const windowMatch = headerSection.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
                const windowStr = windowMatch ? windowMatch[0] : null;

                // Fallback Duration (parsed from "Ends in Xm")
                let headerDurationSeconds = 3600; 
                const durationMatch = headerSection.match(/(?:ENDS|STARTS) IN(.*?)(?:\n|$)/i);
                if (durationMatch && durationMatch[1]) {
                     const timeStr = durationMatch[1];
                     let sec = 0;
                     const h = timeStr.match(/(\d+)\s*h/i);
                     const m = timeStr.match(/(\d+)\s*m/i);
                     const s = timeStr.match(/(\d+)\s*s/i);
                     if (h) sec += parseInt(h[1]) * 3600;
                     if (m) sec += parseInt(m[1]) * 60;
                     if (s) sec += parseInt(s[1]);
                     if (sec > 0) headerDurationSeconds = sec;
                }

                // --- TABLE PARSING ---
                const lines = tableText.split('\n');
                let currentMap = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Check if line contains a Map Name
                    const foundMap = knownMaps.find(m => line.toUpperCase().includes(m.toUpperCase()));
                    if (foundMap) currentMap = foundMap;

                    if (currentMap) {
                        let status = null;
                        // "Now" indicates Active
                        if (line.toLowerCase().includes('now')) {
                            status = 'ACTIVE';
                        } 
                        // "in Xh" indicates Upcoming
                        else if (line.toLowerCase().includes('in ')) {
                            status = 'UPCOMING';
                        }

                        if (status) {
                            results.push({
                                mapName: currentMap,
                                eventType: eventType,
                                status: status,
                                windowStr: windowStr, // Use the header's window for the active event
                                fallbackDuration: headerDurationSeconds,
                                rowText: line // Save text to parse relative time for upcoming
                            });
                        }
                    }
                }
            });

            return results;
        }, KNOWN_MAPS, KNOWN_EVENTS);

        console.log(`[ARC RADAR] ${scrapedData.length} eventos brutos encontrados.`);

        // ENRICHMENT & TIME CALCULATION
        const enrichedEvents = scrapedData.map((evt, index) => {
            let targetTimestamp = null;
            const now = getRealNow(); 

            if (evt.status === 'ACTIVE') {
                // For Active events, we trust the "Window" string (e.g. 11:00 - 12:00) 
                // found in the header to determine the End Time.
                if (evt.windowStr) {
                    targetTimestamp = parseTimeWindowToTimestamp(evt.windowStr, 'END');
                }
                // Fallback if regex failed
                if (!targetTimestamp) {
                    targetTimestamp = now + (evt.fallbackDuration * 1000);
                }
            } 
            else if (evt.status === 'UPCOMING') {
                // For Upcoming, we read the "in 5h 30m" text from the table row
                let rowSeconds = 0;
                const matchesH = evt.rowText.match(/(\d+)\s*[hH]/);
                const matchesM = evt.rowText.match(/(\d+)\s*[mM]/);
                const matchesS = evt.rowText.match(/(\d+)\s*[sS]/); // Rare for upcoming but possible
                if (matchesH) rowSeconds += parseInt(matchesH[1]) * 3600;
                if (matchesM) rowSeconds += parseInt(matchesM[1]) * 60;
                if (matchesS) rowSeconds += parseInt(matchesS[1]);

                if (rowSeconds > 0) {
                    targetTimestamp = now + (rowSeconds * 1000);
                } else {
                     // Safety fallback
                     targetTimestamp = now + 3600000; 
                }
            }

            // Create Unique ID
            const uniqueKey = `${evt.eventType}-${evt.mapName}-${evt.status}-${targetTimestamp}`;

            return {
                _key: uniqueKey,
                mapName: evt.mapName,
                eventType: evt.eventType,
                status: evt.status,
                targetTimestamp: targetTimestamp,
                windowStr: evt.windowStr, 
                scrapedAt: now,
                durationSeconds: Math.floor((targetTimestamp - now) / 1000)
            };
        });

        // DEDUPLICATION
        // Sometimes nested divs cause duplicates. We key by map+event+status.
        const uniqueEvents = [];
        const seenKeys = new Set();
        enrichedEvents.forEach(e => {
             if (!seenKeys.has(e._key)) {
                 seenKeys.add(e._key);
                 uniqueEvents.push(e);
             }
        });

        if (uniqueEvents.length > 0) {
            console.log(`[ARC RADAR] Enviando dados para o Firebase...`);
            
            // Build URL manually for legacy secret auth
            const finalUrl = `${DATABASE_URL}?auth=${cleanSecret}`;
            // console.log(`[DEBUG] URL Destino: ${finalUrl.replace(cleanSecret, '***HIDDEN***')}`);
            
            await axios.put(finalUrl, uniqueEvents, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[ARC RADAR] Sucesso! ${uniqueEvents.length} eventos sincronizados.`);
        } else {
            console.log(`[ARC RADAR] Aviso: Nenhum evento extraído.`);
        }

    } catch (error) {
        if (error.response) {
            // Erro vindo do Firebase (401, 403, etc)
            console.error(`[ARC RADAR] Erro Firebase: ${error.response.status} ${error.response.statusText}`);
            console.error(`[ARC RADAR] Detalhes:`, JSON.stringify(error.response.data));
        } else {
            // Erro de rede ou puppeteer
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
