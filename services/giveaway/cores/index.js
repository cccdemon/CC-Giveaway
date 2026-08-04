'use strict';

// Core-Registry (docs/ARCHITEKTUR-CORES.md §4/§7): löst sessions.core auf das
// Modul auf. Unbekannte oder fehlende IDs fallen auf den heutigen Core zurück —
// Bestands-Sessions (Spalten-Default) laufen damit unverändert.
const watchtimeChat = require('./watchtime-chat.js');

const CORES = Object.freeze({
  [watchtimeChat.id]: watchtimeChat,
  // Phase 3: CORE_CurrentViewers · Phase 4: CORE_TicketBuy
});

const DEFAULT_CORE_ID = watchtimeChat.id;

function getCore(id) {
  return CORES[id] || watchtimeChat;
}

function listCores() {
  return Object.values(CORES).map(c => ({ id: c.id, label: c.label }));
}

module.exports = { CORES, DEFAULT_CORE_ID, getCore, listCores };
