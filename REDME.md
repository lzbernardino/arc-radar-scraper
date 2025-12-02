# 🛰️ ARC RADAR — Event Scraper  
Scraper automático que coleta eventos do jogo **ARC Raiders** diretamente do MetaForge e envia os resultados para o **Firebase Realtime Database**, mantendo horários precisos usando sincronização via relógio atômico.

---

## 🚀 Visão Geral

Este serviço:

- 🕒 Sincroniza a hora com **Relógio Atômico (BRT)**  
- 🔎 Acessa o site MetaForge usando **Puppeteer**  
- 📡 Extrai eventos ativos e futuros  
- 🧠 Converte janelas como `11:00 - 12:00` em timestamps exatos  
- ⏳ Calcula tempos relativos como `in 2h 30m`  
- 🧹 Remove duplicações e inconsistências  
- 🔥 Envia tudo automaticamente para o Firebase  
- 🔁 Executa em loop a cada X minutos  

Ideal como backend para o app **ARC Radar**.

---

## 💾 Estrutura enviada ao Firebase

{
  "_key": "Night Raid-Spaceport-ACTIVE-1730497200000",
  "mapName": "Spaceport",
  "eventType": "Night Raid",
  "status": "ACTIVE",
  "targetTimestamp": 1730497200000,
  "windowStr": "11:00 - 12:00",
  "scrapedAt": 1730493600000,
  "durationSeconds": 3600
}
