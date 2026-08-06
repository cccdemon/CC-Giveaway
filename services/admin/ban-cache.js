'use strict';
// In-Memory-Cache der plattformweit gesperrten Streamer-Logins.
//
// Warum ein Cache: /auth/verify ist der forward_auth-Hot-Path — JEDER Request
// durch Caddy landet dort. Eine PG-Abfrage pro Request wäre der Weg zurück zu
// der Hänger-Klasse, gegen die die Pool-Timeouts in server.js gebaut wurden.
// Stattdessen: Set im Speicher, beim Boot aus PG geladen, von den Ban-/Unban-
// Routen synchron mutiert (Wirkung sofort) und periodisch neu geladen (fängt
// manuelle DB-Änderungen ab). Ein Prozess, also reicht In-Memory — gleiche
// Begründung wie bei loginFails.
//
// Pures Modul ohne pg/express, damit es sich mit node --test testen lässt.

function createBanCache() {
  const set = new Set();
  return {
    has(login)  { return set.has(login); },
    add(login)  { if (login) set.add(login); },
    remove(login) { set.delete(login); },
    replaceAll(logins) {
      set.clear();
      for (const l of logins || []) if (l) set.add(l);
    },
    size() { return set.size; },
  };
}

module.exports = { createBanCache };
