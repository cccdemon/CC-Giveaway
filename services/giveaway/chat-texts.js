'use strict';

// ════════════════════════════════════════════════════════
// Chat-Ansagen-Katalog (Betreiber 18.8.26): jede Broadcast-Ansage hat hier
// einen Eintrag mit Label, Platzhaltern und dem eingebauten Standardtext.
// Teams können je (Core, Nachricht) eine eigene Vorlage speichern
// (chat_templates in Postgres, Engine get/setChatTemplate); der Resolver
// füllt {platzhalter} und hängt auf Wunsch die Links an.
//
// Regeln:
// - OHNE Override kommt exakt der bisherige Text (Defaults rufen die
//   Core-Textfunktionen auf) — Verhalten ändert sich erst durch Editieren.
// - Override: {text, appendTerms, appendPage}. Leerer Text = Standard.
// - Gewinn-Zeile (prizeLine) und Meldefrist-Zeile hängt der Server IMMER
//   an (Pflichtangaben) — sie sind bewusst nicht editierbar.
// - Chat-ANTWORTEN an einzelne Zuschauer (!los, Setz-Bestätigung, …)
//   bleiben Standard und stehen nicht im Katalog.
// ════════════════════════════════════════════════════════

const { getCore } = require('./cores/index.js');

const WT = getCore('CORE_WatchtimeChatActivity');
const CV = getCore('CORE_CurrentViewers');
const TB = getCore('CORE_TicketBuy');
const SC = getCore('CORE_ScreenshotContest');

// {name} → ctx[name]; unbekannte Platzhalter werden leer (nie "{name}" im Chat).
function renderTemplate(tpl, ctx = {}) {
  return String(tpl || '').replace(/\{([a-zA-Z0-9_äöüÄÖÜ]+)\}/g,
    (_, name) => (ctx[name] === undefined || ctx[name] === null) ? '' : String(ctx[name]));
}

// Katalog: Gruppe (_common = core-unabhängig, sonst Core-ID) → key → Eintrag.
// ph = Platzhalter, die die Vorlage nutzen darf (UI-Hinweis + Beispieltext).
const CATALOG = {
  _common: {
    boostStart: { label: 'Boost gestartet', ph: ['minuten', 'faktor'],
      def: c => `⚡ Giveaway-Boost für ${c.minuten} Minuten — Faktor ×${c.faktor} auf Zuschauzeit UND Chat-Bonus. Jetzt zählt jede Minute mehr!` },
    boostEnd: { label: 'Boost abgelaufen', ph: ['faktor'],
      def: c => `⚡ Giveaway-Boost (Faktor ×${c.faktor}) ist abgelaufen — Zuschauzeit zählt wieder normal.` },
    boostStop: { label: 'Boost vorzeitig beendet', ph: [],
      def: () => '⚡ Giveaway-Boost vorzeitig beendet — Zuschauzeit zählt wieder normal.' },
  },
  CORE_WatchtimeChatActivity: {
    open: { label: 'Eröffnung', ph: ['keyword', 'followMin', 'gewinn', 'sponsor'],
      def: c => '🎉 Das Giveaway ist ERÖFFNET! ' + WT.infoText({
        keyword: c.keyword, followMin: c.followMin, drawMinSec: c.drawMinSec,
        host: c.host, teamId: c.teamId }) },
    pause: { label: 'Pausiert (manuell)', ph: [],
      def: () => '⏸ Giveaway pausiert — Zuschauzeit zählt gerade nicht. Euer Punktestand bleibt erhalten.' },
    pauseAuto: { label: 'Pausiert (alle Streams offline)', ph: [],
      def: () => '⏸ Giveaway pausiert — alle Team-Kanäle sind offline. Zuschauzeit zählt gerade nicht, euer Punktestand bleibt erhalten.' },
    resume: { label: 'Läuft weiter (manuell)', ph: [],
      def: () => '▶ Giveaway läuft weiter — Zuschauzeit zählt ab jetzt wieder.' },
    resumeAuto: { label: 'Läuft weiter (Stream online)', ph: [],
      def: () => '▶ Giveaway läuft weiter — der Stream ist wieder online, Zuschauzeit zählt ab jetzt wieder.' },
    closed: { label: 'Geschlossen', ph: [],
      def: () => '🔒 Das Giveaway ist GESCHLOSSEN — ab jetzt zählt keine Zuschauzeit mehr. Die Ziehung erfolgt gewichtet nach Punkten unter allen Zugelassenen. Viel Glück!' },
    winner: { label: 'Gewinner-Ansage', ph: ['gewinner', 'gewinn'],
      def: c => `🎉 Gewinner: @${c.gewinner} — herzlichen Glückwunsch!` },
  },
  CORE_CurrentViewers: {
    prep: { label: 'Vorankündigung (ohne Fenster)', ph: ['keyword'],
      def: c => CV.prepText({ keyword: c.keyword }) },
    windowOpen: { label: 'Anmeldefenster offen', ph: ['keyword', 'minuten'],
      def: c => CV.infoText({ keyword: c.keyword, windowSec: c.windowSec, minWatchSec: c.minWatchSec }) },
    windowClosed: { label: 'Anmeldefenster geschlossen', ph: ['anzahl'],
      def: c => `⚡ Anmeldefenster geschlossen — ${c.anzahl} im Topf. Die Ziehung macht der Streamer gleich live!` },
    closed: { label: 'Geschlossen', ph: [],
      def: () => '⚡ Anmeldung beendet — die Ziehung macht der Streamer jetzt live!' },
    reopened: { label: 'Wieder geöffnet', ph: [],
      def: () => '⚡ Die Verlosung ist wieder offen!' },
    winner: { label: 'Gewinner-Ansage', ph: ['gewinner'],
      def: c => CV.winnerText({ winner: c.gewinner }) },
  },
  CORE_TicketBuy: {
    open: { label: 'Eröffnung', ph: ['keyword', 'befehl', 'gewinn', 'sponsor'],
      def: c => TB.infoText({ cmd: c.befehl, keyword: c.keyword, url: c.pageUrl }) },
    closed: { label: 'Geschlossen (Guthaben gutgeschrieben)', ph: ['konten'],
      def: c => `🎟 Los-Giveaway beendet — eure Zuschauzeit ist jetzt Los-Guthaben (${c.konten} Konten gutgeschrieben). Es bleibt erhalten und zählt beim nächsten Los-Giveaway weiter. Die Ziehung folgt gleich!` },
    reopened: { label: 'Wieder geöffnet', ph: [],
      def: () => '🎟 Das Los-Giveaway läuft weiter — Zuschauzeit zählt wieder als Los-Guthaben (euer Guthaben bleibt erhalten).' },
    prizeAdded: { label: 'Preis angelegt', ph: ['nr', 'preis', 'sponsor', 'befehl', 'minuten'],
      def: c => `🎁 Neuer Preis #${c.nr}: „${c.preis}"`
        + (c.sponsor ? ` (bereitgestellt von ${c.sponsor})` : '')
        + ` — Lose setzen mit „${c.befehl} <anzahl>"`
        + (c.minuten ? ` (Einsatz-Ende in ${c.minuten} min).` : '.') },
    prizeCancelled: { label: 'Preis storniert', ph: ['nr', 'preis', 'anzahl'],
      def: c => `🎁 Preis #${c.nr} „${c.preis}" wurde storniert`
        + (c.anzahl ? ` — alle Einsätze (${c.anzahl} Teilnehmer) sind zurückgebucht.` : '.') },
    wagerCmd: { label: 'Setz-Befehl geändert', ph: ['befehl'],
      def: c => `🎟 Lose setzen geht ab jetzt mit „${c.befehl} <anzahl>".` },
    page: { label: 'Setz-Seite angesagt', ph: ['befehl'],
      def: c => `🎟 Lose setzen: ${c.pageUrl} (Login mit Twitch) — oder im Chat mit „${c.befehl} <anzahl>".` },
    winner: { label: 'Gewinner-Ansage', ph: ['gewinner', 'preis'],
      def: c => TB.winnerText({ winner: c.gewinner, prizeTitle: c.preis }) },
  },
  CORE_ScreenshotContest: {
    open: { label: 'Eröffnung', ph: ['gewinn', 'sponsor'],
      def: c => SC.infoText({ url: c.pageUrl }) },
    closed: { label: 'Geschlossen', ph: [],
      def: () => '📸 Der Screenshot-Contest ist beendet — danke an alle Einsender! Die Ziehung folgt.' },
    votingOpen: { label: 'Voting offen', ph: [],
      def: c => `📸 Das VOTING ist offen! Bewerte die Screenshots mit 1–10 auf ${c.pageUrl} (Login mit Twitch).` },
    votingPaused: { label: 'Voting pausiert', ph: [],
      def: () => '📸 Voting pausiert — abgegebene Stimmen bleiben erhalten.' },
    votingClosed: { label: 'Voting beendet', ph: [],
      def: () => '📸 Voting beendet — die Auswertung folgt!' },
    page: { label: 'Contest-Seite angesagt', ph: [],
      def: c => `📸 Screenshot-Contest: Einsenden und Bewerten auf ${c.pageUrl} (Login mit Twitch).` },
    winner: { label: 'Gewinner-Ansage', ph: ['gewinner', 'punkte'],
      def: c => SC.winnerText({ winner: c.gewinner, coins: c.punkte }) },
  },
};

// Beispielwerte für die Vorschau im Panel (listChatTexts.defaultText).
const SAMPLE_CTX = Object.freeze({
  keyword: 'gewinnspiel', befehl: '!setzen', minuten: 15, faktor: 2,
  gewinner: 'zuschauer123', preis: 'Headset', gewinn: 'Headset', sponsor: '',
  nr: 3, anzahl: 7, konten: 12, punkte: 42, followMin: 2, drawMinSec: 7200,
  windowSec: 300, minWatchSec: 600, host: 'team.raumdock.org', teamId: 'team_x',
  termsUrl: 'https://team.raumdock.org/viewer/terms?team=team_x',
  pageUrl: 'https://team.raumdock.org/viewer/wager',
});

// Wirksamen Text auflösen. override = {text, appendTerms, appendPage} | null.
// Fail-open: kaputte Vorlage/unbekannter Key darf keine Ansage crashen.
function resolveChatText(groupId, key, ctx = {}, override = null) {
  if (override && typeof override.text === 'string' && override.text.trim()) {
    let out = renderTemplate(override.text, ctx);
    if (override.appendTerms && ctx.termsUrl) out += ` Teilnahmebedingungen: ${ctx.termsUrl}`;
    if (override.appendPage && ctx.pageUrl) out += ` → ${ctx.pageUrl}`;
    return out;
  }
  const entry = (CATALOG[groupId] || {})[key];
  if (!entry) return '';
  try { return entry.def(ctx) || ''; } catch { return ''; }
}

// Katalog einer Gruppe fürs Panel: Label, Platzhalter, Beispieltext.
function listChatTexts(groupId) {
  const group = CATALOG[groupId] || {};
  return Object.keys(group).map(key => {
    let defaultText = '';
    try { defaultText = group[key].def(SAMPLE_CTX) || ''; } catch { /* Beispiel entfällt */ }
    return { key, label: group[key].label, placeholders: group[key].ph, defaultText };
  });
}

module.exports = { renderTemplate, resolveChatText, listChatTexts, SAMPLE_CTX, CATALOG };
