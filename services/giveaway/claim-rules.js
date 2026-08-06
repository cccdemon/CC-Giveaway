'use strict';

// ── P6 (Restpunkte): Sperr-Regel für Ersatzziehungen ─────────────────────
// Ein bereits wirksam abgewickelter Gewinn darf nicht durch eine normale
// Ersatzziehung dupliziert werden — sonst gäbe es zwei gültige Ansprüche
// auf denselben Gewinn. Blockiert wird, sobald der Gewinner erfolgreich
// gemeldet hat (status 'claimed') ODER der Veranstalter die Abwicklung
// begonnen hat (handling contacted/shipped/done). pending, expired und
// replaced sind frei — genau dafür ist der Ersatz da.
// Pures Modul (testbar ohne Server); der gw_draw_winner-Handler nutzt es.

const HANDLED = new Set(['contacted', 'shipped', 'done']);

// claim = { status, handling } | null. Rückgabe: null = Ersatz erlaubt,
// sonst der Grund der Sperre ('claimed' | 'contacted' | 'shipped' | 'done').
function rerollBlocked(claim) {
  if (!claim) return null;
  if (claim.handling && HANDLED.has(claim.handling)) return claim.handling;
  if (claim.status === 'claimed') return 'claimed';
  return null;
}

const REROLL_BLOCK_MSG = {
  claimed:   'Der Gewinner hat sich bereits gemeldet',
  contacted: 'Der Veranstalter hat den Gewinner bereits kontaktiert',
  shipped:   'Der Gewinn ist bereits versendet',
  done:      'Die Abwicklung ist bereits abgeschlossen',
};

module.exports = { rerollBlocked, REROLL_BLOCK_MSG };
