
const puppeteer = require('puppeteer');
const axios = require('axios');

// CONFIG
const FIREBASE_SECRET = 'JbXhB8D2qIXuQyRoNZIArvX9Q6vqUGA7HunILgBl'; 
const DATABASE_URL = 'https://arc-radar-default-rtdb.firebaseio.com/events.json';
const REFRESH_INTERVAL_MINUTES = 60; // Check hourly (App handles interpolation)
const TARGET_URL = 'https://metaforge.app/arc-raiders/event-timers';

const KNOWN_MAPS = ['Buried City', 'Dam Battlegrounds', 'Dam', 'The Spaceport', 'Spaceport', 'Blue Gate', 'Stella Montis'];
const KNOWN_EVENTS = ['Night Raid', 'Electromagnetic Storm', 'Matriarch', 'Harvester', 'Hidden Bunker', 'Husk Graveyard', 'Prospecting Probes', 'Uncovered Caches', 'Standard Patrol', 'Lush Blooms', 'Inquisitor'];

// GLOBAL OFFSET 
let CLOCK_OFFSET = 0;

function getRealNow() {
    return Date.now() + CLOCK_OFFSET;
}

// Parses "11:00 - 12:00" into an absolute Timestamp (FALLBACK ONLY)
function parseTimeWindowToTimestamp(windowStr, type) {
    try {
        if (!windowStr || !windowStr.includes('-')) return null;

        const parts = windowStr.split('-').map(s => s.trim());
        const timeStr = type === 'END' ? parts[1] : parts[0];
        const [h, m] = timeStr.split(':');

        const now = getRealNow();
        
        // Default to local server time construction to avoid offset math errors
        const d = new Date(now);
        d.setHours(parseInt(h), parseInt(m), 0, 0);
        
        let targetTs = d.getTime();

        // Handle Day Rollover (If target is in the past, maybe it's tomorrow, or if it's way in future, maybe it was yesterday)
        // Simple logic: if target is more than 12h away from now, adjust.
        // But since we prioritize "ENDS IN", this is rarely used.
        if (targetTs < now - (12 * 3600 * 1000)) {
            targetTs += 24 * 3600 * 1000; 
        }
        
        return targetTs;

    } catch (e) {
        console.log("Error parsing window:", e.message);
        return null;
    }
}

async function scrapeAndSave() {
    console.log(`\n[ARC RADAR] --- Iniciando Scanner: ${new Date().toLocaleTimeString('pt-BR')} (Server Time) ---`);
    
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
        await page.setViewport({ width: 1440, height: 2500 });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        console.log(`[ARC RADAR] Acessando MetaForge...`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for hydration
        await new Promise(r => setTimeout(r, 5000));

        // SCRAPING LOGIC
        const scrapedData = await page.evaluate((knownMaps, knownEvents) => {
            const results = [];
            const divs = Array.from(document.querySelectorAll('div'));
            
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

                const parts = fullText.split(/Upcoming windows/i);
                if (parts.length < 2) return;

                const headerSection = parts[0];
                const tableText = parts[1];

                const headerUpper = headerSection.toUpperCase();
                const eventType = knownEvents.find(e => headerUpper.includes(e.toUpperCase())) || "Unknown";

                const windowMatch = headerSection.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
                const windowStr = windowMatch ? windowMatch[0] : null;

                // CRITICAL: Extract "ENDS IN" or "STARTS IN" duration precisely
                let headerDurationSeconds = 0; 
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
                     headerDurationSeconds = sec;
                }

                const lines = tableText.split('\n');
                let currentMap = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const foundMap = knownMaps.find(m => line.toUpperCase().includes(m.toUpperCase()));
                    if (foundMap) currentMap = foundMap;

                    if (currentMap) {
                        let status = null;
                        if (line.toLowerCase().includes('now')) {
                            status = 'ACTIVE';
                        } 
                        else if (line.toLowerCase().includes('in ')) {
                            status = 'UPCOMING';
                        }

                        // Try to get specific row duration if available
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
                                rowDuration: rowSeconds,
                                rowText: line 
                            });
                        }
                    }
                }
            });

            return results;
        }, KNOWN_MAPS, KNOWN_EVENTS);

        console.log(`[ARC RADAR] ${scrapedData.length} eventos brutos encontrados.`);

        const enrichedEvents = scrapedData.map((evt, index) => {
            let targetTimestamp = null;
            const now = getRealNow(); 

            // LOGIC CORRECTION: Priority to relative duration (ENDS IN / STARTS IN)
            // This avoids Timezone Offset errors completely.

            if (evt.status === 'ACTIVE') {
                // If it's active, we want to know when it ENDS.
                // Priority 1: Use header duration "ENDS IN 58m"
                if (evt.headerDuration > 0) {
                    targetTimestamp = now + (evt.headerDuration * 1000);
                } 
                // Priority 2: Use window string parsing (Risky due to timezone)
                else if (evt.windowStr) {
                    targetTimestamp = parseTimeWindowToTimestamp(evt.windowStr, 'END');
                }
                // Fallback: 1 hour from now
                else {
                    targetTimestamp = now + 3600000;
                }
            } 
            else if (evt.status === 'UPCOMING') {
                // Priority 1: Row duration "Starts in 2h"
                if (evt.rowDuration > 0) {
                    targetTimestamp = now + (evt.rowDuration * 1000);
                }
                // Priority 2: Header duration "Starts in ..." (Less precise for specific maps)
                else if (evt.headerDuration > 0) {
                    targetTimestamp = now + (evt.headerDuration * 1000);
                }
                else {
                     targetTimestamp = now + 3600000; 
                }
            }

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

        const uniqueEvents = [];
        const seenKeys = new Set();
        enrichedEvents.forEach(e => {
             // Basic dedupe
             const simpleKey = e.mapName + e.eventType + e.status;
             if (!seenKeys.has(simpleKey)) {
                 seenKeys.add(simpleKey);
                 uniqueEvents.push(e);
             }
        });

        if (uniqueEvents.length > 0) {
            console.log(`[ARC RADAR] Enviando dados para o Firebase...`);
            
            // AUTH LEGACY via URL string
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
