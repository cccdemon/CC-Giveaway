'use strict';

// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Watchtime / Ticket Engine (multi-tenant)
// Alles pro (team, user, channel). Redis-Keys mit t:{teamId}: Prefix.
// Kanäle eines Teams = dessen team_members (PG, kurz gecacht).
// Coin-Basis ist PRO TEAM einstellbar (getCoinBaseSec, Default 7200s = 2h);
// die Konstanten hier sind nur Fallback. Chat (>3 Wörter) = +CHAT_BONUS_SEC.
// Viewtime-Multiplier (time-boxed) gilt Tick+Chat. Opt-in via Keyword.
// Eligibility: Keyword + ≥followMin gefolgte Kanäle + ≥1 Coin (getUserAggregate).
// Gewicht der Ziehung = Summe Coins.
// ════════════════════════════════════════════════════════

const { randomInt, createHash, randomBytes } = require('crypto');

// Mechanik-Regeln (Coin-Formel, Eligibility, Pool, Chat-Urteil) liegen seit
// Phase 1 des Core-Umbaus im Core (docs/ARCHITEKTUR-CORES.md). Die Engine
// sammelt Rohdaten aus Redis/PG und delegiert die Regeln dorthin.
// Phase 3: Instanzen können einen anderen Core fahren (getCore-Registry);
// CORE bleibt der Default (Primary + Bestand).
const CORE = require('./cores/watchtime-chat');
const { getCore } = require('./cores/index.js');
const { CreditLedger } = require('./credit.js');

// ── Anti-Abuse: deterministische, reproduzierbare Schwellen ──
const ABUSE = {
  HIST_LEN: 20, TIMES_LEN: 30,
  DUP_MIN: 3,               // identische Nachricht ≥3× im Fenster → dup_message
  RATE_WINDOW: 60, RATE_MAX: 10,   // >10 Nachrichten / 60s → high_rate
  DIV_MIN_MSGS: 10, DIV_RATIO: 0.4, // ≥10 Nachrichten, <40% verschieden → low_diversity
  NEW_ACCOUNT_DAYS: 30,     // Twitch-Account jünger als 30 Tage → new_account
};

// Mechanik-Defaults kommen aus dem Core; Re-Export unten erhält die alte API.
const { SECS_PER_COIN, CHAT_BONUS_SEC, CHAT_COOLDOWN, CHAT_MIN_WORDS,
        MIN_CHANNELS, JOIN_MIN_COINS } = CORE.defaults;
const TICK_SEC       = 60;
const PRESENCE_TTL   = 600;
const CHANNELS_TTL   = 30;   // Cache der Team-Kanäle (s)

const TP = (t) => `t:${t}:`;
const K = {
  openTeams:    () => 'gw:open_teams',                    // GLOBAL: Teams mit offenem Giveaway
  gwOpen:       (t) => `${TP(t)}gw_open`,
  gwPaused:     (t) => `${TP(t)}gw_paused`,               // pausiert = kein Accrual, State bleibt
  gwKeyword:    (t) => `${TP(t)}gw_keyword`,
  gwSessionId:  (t) => `${TP(t)}gw_session_id`,
  gwChannels:   (t) => `${TP(t)}gw:channels`,             // Cache
  gwMult:       (t) => `${TP(t)}gw:mult`,
  gwUsers:      (t) => `${TP(t)}gw:users`,
  gwOnline:     (t) => `${TP(t)}gw:online`,               // SET aktuell live Kanäle
  gwAutoPaused: (t) => `${TP(t)}gw:auto_paused`,          // '1' = vom Auto-Pause pausiert
  cfgAutoPause: (t) => `${TP(t)}gw:cfg:auto_pause`,       // '1' = Pause wenn alle Streams offline
  cfgAutoResume:(t) => `${TP(t)}gw:cfg:auto_resume`,      // '1' = Start/Resume wenn ein Stream online
  cfgFollowMin: (t) => `${TP(t)}gw:cfg:follow_min`,       // wie vielen Kanälen muss man folgen (Teilnahmebedingung)
  cfgDrawMinSec:(t) => `${TP(t)}gw:cfg:draw_min_sec`,     // min. Viewtime (Sek.) um im Lostopf berücksichtigt zu werden
  cfgChatOn:    (t) => `${TP(t)}gw:cfg:chat_enabled`,     // '0' = Chat-Bonus aus (Wert bleibt erhalten)
  cfgChatBonus: (t) => `${TP(t)}gw:cfg:chat_bonus_sec`,   // Sek. Viewtime pro sinnvoller Chatnachricht
  cfgChatWords: (t) => `${TP(t)}gw:cfg:chat_min_words`,   // ab wie vielen Wörtern eine Nachricht zählt
  cfgChatCool:  (t) => `${TP(t)}gw:cfg:chat_cooldown`,    // Sek. Sperre zwischen zwei Boni
  userTeams:    (u) => `gw:user_teams:${u}`,              // GLOBAL Reverse-Index: Teams eines Users
  gwRegistered: (t, u) => `${TP(t)}gw:registered:${u}`,
  gwBanned:     (t, u) => `${TP(t)}gw_banned:${u}`,
  chWatch:    (t, ch, u) => `${TP(t)}gw:ch:${ch}:watch:${u}`,
  chChatTs:   (t, ch, u) => `${TP(t)}gw:ch:${ch}:chat_ts:${u}`,
  chPresent:  (t, ch, u) => `${TP(t)}gw:ch:${ch}:present:${u}`,
  chLastTick: (t, ch, u) => `${TP(t)}gw:ch:${ch}:last_tick:${u}`,
  chMsgs:     (t, ch, u) => `${TP(t)}gw:ch:${ch}:msgs:${u}`,
  chFollows:  (t, ch, u) => `${TP(t)}gw:ch:${ch}:follows:${u}`,
  chIndex:    (t, ch)    => `${TP(t)}gw:ch:${ch}:index`,
  // Puls je Kanal: Zeitstempel des letzten viewer_tick UND wie viele
  // Zuschauer er trug. Ohne den Puls ist "kommen ueberhaupt Ticks an?"
  // nur ueber einen Key-Scan zu beantworten — und genau diese Frage hat
  // am 9.8.26 eine Sofortverlosung gekostet (Ticks fehlten, Topf leer).
  chPulse:    (t, ch)    => `${TP(t)}gw:ch:${ch}:pulse`,
  // ── Phase 2b: Giveaway-Dimension (docs/ARCHITEKTUR-CORES.md §6) ──
  // Accrual-Zustand liegt je Giveaway (gid = Session-ID) unter t:<team>:g:<gid>:.
  // Team-weit BLEIBEN bewusst: Presence/LastTick (Anwesenheit), Follows
  // (Zuschauer-Eigenschaft), Index, Users, Banned, Keyword, cfg:* (Migration
  // nach core_config folgt). Alte Schlüssel werden beim ersten Zugriff in den
  // g:-Namespace migriert (Rename) — ein laufendes Giveaway übersteht den Deploy.
  GP:        (t, g) => `${TP(t)}g:${g}:`,
  gWatch:    (t, g, ch, u) => `${K.GP(t, g)}ch:${ch}:watch:${u}`,
  gChatTs:   (t, g, ch, u) => `${K.GP(t, g)}ch:${ch}:chat_ts:${u}`,
  gMsgs:     (t, g, ch, u) => `${K.GP(t, g)}ch:${ch}:msgs:${u}`,
  gReg:      (t, g, u)     => `${K.GP(t, g)}registered:${u}`,
  gMult:     (t, g)        => `${K.GP(t, g)}mult`,
  // Phase 2c: Parallelbetrieb — Set aktiver Giveaways + Zustand je Instanz.
  // Der Legacy-Single-Pfad (gwOpen/gwSessionId/gwKeyword) bleibt das
  // "Primary"-Giveaway; Sekundär-Instanzen leben ausschließlich hier.
  gwSet:     (t) => `${TP(t)}giveaways`,
  gOpen:     (t, g) => `${K.GP(t, g)}open`,
  gPaused:   (t, g) => `${K.GP(t, g)}paused`,
  gKw:       (t, g) => `${K.GP(t, g)}keyword`,
  gChanList: (t, g) => `${K.GP(t, g)}channels`,
  gCore:     (t, g) => `${K.GP(t, g)}core`,      // Core-ID der Instanz (Phase 3)
  gWinEnd:   (t, g) => `${K.GP(t, g)}win_end`,   // Fensterende (Unix-Sek., Sofortverlosung)
  gWagerCmd: (t, g) => `${K.GP(t, g)}wager_cmd`, // Setz-Befehl (Phase 4b, WebUI-konfigurierbar)
  gMinWatch: (t, g) => `${K.GP(t, g)}min_watch`, // Contest: Mindest-Viewtime Einsenden/Voten (Phase 6)
  gVoteState:(t, g) => `${K.GP(t, g)}vote_state`,// Contest: Voting closed|open|paused (Phase 6)
  gAnnounce: (t, g) => `${K.GP(t, g)}announce`,  // CV: Chat-Ansagen ('false' = stumm; Gewinner-Ansage bleibt)
  gName:     (t, g) => `${K.GP(t, g)}name`,      // frei vergebbarer Anzeigename der Instanz (Panel)
  // Per-Giveaway-Konfiguration: beim Öffnen aus den Team-Vorgaben kopiert
  // (copyCfgToInstance) — Änderungen wirken danach NUR auf dieses Giveaway.
  // Team-Keys (cfg* oben) bleiben die Vorgaben für den nächsten Start und
  // der Fallback für Alt-Instanzen ohne Kopie.
  gCfgFollowMin: (t, g) => `${K.GP(t, g)}cfg:follow_min`,
  gCfgCoinBase:  (t, g) => `${K.GP(t, g)}cfg:draw_min_sec`,
  gCfgChatOn:    (t, g) => `${K.GP(t, g)}cfg:chat_enabled`,
  gCfgChatBonus: (t, g) => `${K.GP(t, g)}cfg:chat_bonus_sec`,
  gCfgChatWords: (t, g) => `${K.GP(t, g)}cfg:chat_min_words`,
  gCfgChatCool:  (t, g) => `${K.GP(t, g)}cfg:chat_cooldown`,
  abuseHist:  (t, u) => `${TP(t)}gw:abuse:hist:${u}`,     // letzte Msg-Hashes
  abuseTimes: (t, u) => `${TP(t)}gw:abuse:times:${u}`,    // letzte Timestamps (Rate)
};

function sanitizeUsername(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
}
const sanitizeChannel = sanitizeUsername;

function sanitizeStr(s, maxLen = 100) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[^\x20-\x7e]|[<>"']/g, '').slice(0, maxLen);
}

// Keyword-Match: das Keyword muss als eigenes Wort in der Nachricht stehen.
// Exakte Gleichheit der ganzen Nachricht war zu streng — "!basher 🎉" oder
// "!basher bin dabei" sind eindeutig als Anmeldung gemeint und wurden verworfen.
// Satzzeichen am Wortrand werden ignoriert, das Keyword selbst behält seine
// Sonderzeichen (z.B. das führende "!").
function matchesKeyword(message, keyword) {
  const kw = sanitizeStr(keyword || '', 100).trim().toLowerCase();
  if (!kw) return false;
  const strip = (w) => w.replace(/^[.,;:!?"'()\[\]]+|[.,;:!?"'()\[\]]+$/g, '');
  const kwBare = strip(kw);
  for (const word of String(message || '').toLowerCase().split(/\s+/)) {
    if (!word) continue;
    if (word === kw) return true;
    if (kwBare && strip(word) === kwBare) return true;
  }
  return false;
}

// Formeln liegen im Core; Aliase hier erhalten die bestehende API
// (Tests und server.js importieren sie weiter aus watchtime.js).
const countWords   = CORE.countWords;
const coinsFromSec = CORE.coinsFromSec;

function sanitizeTeamId(t) {
  return String(t || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
}

class WatchtimeEngine {
  // aiJudge: optionaler async (teamId, message) => {meaningful: bool|null, source}
  // Wird von server.js injiziert. Ohne ihn zählt weiterhin die Wortregel.
  constructor(redis, pg, aiJudge = null) {
    this.redis   = redis;
    this.pg      = pg;
    this.aiJudge = aiJudge;
    this.credit  = new CreditLedger(pg);   // Guthaben-Konto (CORE_TicketBuy)
  }

  // ── Team-Kanäle (aus team_members, gecacht) ─────────────
  async getChannels(teamId) {
    const t = sanitizeTeamId(teamId);
    const cached = await this.redis.get(K.gwChannels(t));
    if (cached) { try { const a = JSON.parse(cached); if (Array.isArray(a)) return a; } catch { /* refetch */ } }
    let chans = [];
    try {
      const r = await this.pg.query('SELECT channel FROM team_members WHERE team_id=$1 ORDER BY joined_at', [t]);
      chans = r.rows.map(x => sanitizeChannel(x.channel)).filter(Boolean);
    } catch(e) { console.error('[WTE] getChannels:', e.message); }
    await this.redis.set(K.gwChannels(t), JSON.stringify(chans), 'EX', CHANNELS_TTL);
    return chans;
  }

  async resolveChannel(teamId, channel) {
    const ch = sanitizeChannel(channel);
    if (ch) return ch;
    return (await this.getChannels(teamId))[0] || '';
  }

  // ── Multiplier (per Giveaway, Legacy-Fallback nur Primary) ──
  // Sekundär-Instanzen lesen strikt ihren eigenen Schlüssel — ein Alt-Boost
  // darf nie in ein fremdes Giveaway leaken.
  async getMultiplier(teamId, gid = undefined) {
    const t = sanitizeTeamId(teamId);
    const primary = await this.redis.get(K.gwSessionId(t));
    const g = gid === undefined ? primary : gid;
    let raw;
    if (!g)                   raw = await this.redis.get(K.gwMult(t));
    else if (!primary || g === primary) raw = await this._readMech(K.gMult(t, g), K.gwMult(t));
    else                      raw = await this.redis.get(K.gMult(t, g));
    const f = parseFloat(raw || '1');
    return (isFinite(f) && f > 0) ? f : 1;
  }
  // Per-Giveaway-Override lesen: g:-Key vor Team-Key. gid=null → Team-Wert
  // (Vorgabe für den nächsten Start bzw. Fallback für Alt-Instanzen).
  async _cfgRaw(teamId, gid, gKeyFn, teamKeyFn) {
    const t = sanitizeTeamId(teamId);
    if (gid) {
      const v = await this.redis.get(gKeyFn(t, gid));
      if (v !== null && v !== undefined) return v;
    }
    return this.redis.get(teamKeyFn(t));
  }
  // Teilnahmebedingung: wie vielen Kanälen muss man folgen (default MIN_CHANNELS).
  async getFollowMin(teamId, gid = null) {
    const v = parseInt(await this._cfgRaw(teamId, gid, K.gCfgFollowMin, K.cfgFollowMin), 10);
    return (Number.isFinite(v) && v >= 0) ? v : MIN_CHANNELS;
  }
  async setFollowMin(teamId, n, gid = null) {
    const t = sanitizeTeamId(teamId);
    const c = CORE.config.followMin;   // Grenzen aus der Core-Deklaration
    const v = Math.max(c.min, Math.min(c.max, parseInt(n, 10) || 0));
    await this.redis.set(gid ? K.gCfgFollowMin(t, gid) : K.cfgFollowMin(t), String(v));
    return v;
  }
  // Coin-Basis (Sek.) = EIN Wert für zwei Dinge:
  //   1 Coin  = coinBaseSec Viewtime
  //   Lostopf = ab 1 Coin, also ebenfalls coinBaseSec Viewtime
  // Redis-Key bleibt cfgDrawMinSec (Abwärtskompatibilität bestehender Configs).
  async getCoinBaseSec(teamId, gid = null) {
    const v = parseInt(await this._cfgRaw(teamId, gid, K.gCfgCoinBase, K.cfgDrawMinSec), 10);
    return (Number.isFinite(v) && v >= 60) ? v : SECS_PER_COIN;   // 7200 = 2h
  }
  async setCoinBaseSec(teamId, sec, gid = null) {
    const t = sanitizeTeamId(teamId);
    const c = CORE.config.coinBaseSec;   // 1min..100h, aus der Core-Deklaration
    const v = Math.max(c.min, Math.min(c.max, Math.round(parseFloat(sec) || 0)));
    await this.redis.set(gid ? K.gCfgCoinBase(t, gid) : K.cfgDrawMinSec(t), String(v));
    return v;
  }
  // Alias: Schwelle für den Lostopf == Coin-Basis (1 Coin).
  async getDrawMinSec(teamId, gid = null) { return this.getCoinBaseSec(teamId, gid); }
  async setDrawMinSec(teamId, sec, gid = null) { return this.setCoinBaseSec(teamId, sec, gid); }

  // Chat-Bonus. Defaults = die bisherigen Konstanten.
  async getChatConfig(teamId, gid = null) {
    const num = async (gKey, tKey, def, min, max) => {
      const v = parseFloat(await this._cfgRaw(teamId, gid, gKey, tKey));
      return (Number.isFinite(v) && v >= min && v <= max) ? v : def;
    };
    const cc = CORE.config;   // Defaults + Grenzen aus der Core-Deklaration
    return {
      // Expliziter An/Aus-Schalter: '0' = aus. Der Bonuswert bleibt dabei
      // gespeichert — Wiedereinschalten stellt die alten Regeln wieder her.
      enabled: (await this._cfgRaw(teamId, gid, K.gCfgChatOn, K.cfgChatOn)) !== '0',
      bonusSec: await num(K.gCfgChatBonus, K.cfgChatBonus, cc.chatBonusSec.def, cc.chatBonusSec.min, cc.chatBonusSec.max),
      minWords: await num(K.gCfgChatWords, K.cfgChatWords, cc.chatMinWords.def, cc.chatMinWords.min, cc.chatMinWords.max),
      cooldown: await num(K.gCfgChatCool,  K.cfgChatCool,  cc.chatCooldown.def, cc.chatCooldown.min, cc.chatCooldown.max),
    };
  }
  async setChatConfig(teamId, cfg = {}, gid = null) {
    const t = sanitizeTeamId(teamId);
    const put = async (gKey, tKey, val, min, max, round) => {
      if (val === undefined || val === null || val === '') return;
      let v = parseFloat(val);
      if (!Number.isFinite(v)) return;
      v = Math.max(min, Math.min(max, round ? Math.round(v) : v));
      await this.redis.set(gid ? gKey(t, gid) : tKey(t), String(v));
    };
    const cc = CORE.config;
    if (cfg.enabled !== undefined && cfg.enabled !== null) {
      await this.redis.set(gid ? K.gCfgChatOn(t, gid) : K.cfgChatOn(t), cfg.enabled ? '1' : '0');
    }
    await put(K.gCfgChatBonus, K.cfgChatBonus, cfg.bonusSec, cc.chatBonusSec.min, cc.chatBonusSec.max, false);
    await put(K.gCfgChatWords, K.cfgChatWords, cfg.minWords, cc.chatMinWords.min, cc.chatMinWords.max, true);
    await put(K.gCfgChatCool,  K.cfgChatCool,  cfg.cooldown, cc.chatCooldown.min, cc.chatCooldown.max, true);
    return this.getChatConfig(t, gid);
  }

  // Copy-on-Open: die aktuellen Team-Vorgaben werden die EIGENEN Werte des
  // neuen Giveaways. Danach ändert die Settings-Karte nur noch dieses
  // Giveaway; die Vorgaben bleiben für den nächsten Start unberührt.
  async copyCfgToInstance(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    if (!gid) return;
    const chat = await this.getChatConfig(t);
    await this.redis.set(K.gCfgFollowMin(t, gid), String(await this.getFollowMin(t)));
    await this.redis.set(K.gCfgCoinBase(t, gid),  String(await this.getCoinBaseSec(t)));
    await this.redis.set(K.gCfgChatOn(t, gid), chat.enabled ? '1' : '0');
    await this.redis.set(K.gCfgChatBonus(t, gid), String(chat.bonusSec));
    await this.redis.set(K.gCfgChatWords(t, gid), String(chat.minWords));
    await this.redis.set(K.gCfgChatCool(t, gid),  String(chat.cooldown));
  }
  async setMultiplier(teamId, factor, seconds, explicitGid = undefined) {
    const t = sanitizeTeamId(teamId);
    const primary = await this._gid(t);
    const gid = explicitGid === undefined ? primary : explicitGid;
    const isPrimary = !gid || gid === primary;   // Legacy-Key gehört NUR dem Primary
    const key = gid ? K.gMult(t, gid) : K.gwMult(t);
    const f = Math.max(1, Math.min(10, parseFloat(factor) || 1));
    const s = Math.max(1, Math.min(86400, parseInt(seconds) || 0));
    if (f <= 1 || !s) {
      await this.redis.del(key);
      if (isPrimary) await this.redis.del(K.gwMult(t));   // Altbestand nie parallel weiterlaufen lassen
      return { factor: 1, seconds: 0, gid: gid || null };
    }
    await this.redis.set(key, String(f), 'EX', s);
    if (gid && isPrimary) await this.redis.del(K.gwMult(t));
    return { factor: f, seconds: s, gid: gid || null };
  }
  async multiplierState(teamId, gid = undefined) {
    const t = sanitizeTeamId(teamId);
    const f = await this.getMultiplier(t, gid);
    if (f <= 1) return { factor: f, secondsLeft: 0 };
    const g = gid === undefined ? await this._gid(t) : gid;
    let ttl = g ? await this.redis.ttl(K.gMult(t, g)) : -2;
    if (ttl < 0) ttl = await this.redis.ttl(K.gwMult(t));
    return { factor: f, secondsLeft: ttl > 0 ? ttl : 0 };
  }

  _followAllowed(val) { return val !== '0'; }

  // ── Phase 2b: Giveaway-Dimension ────────────────────────
  // gid = Session-ID des laufenden Giveaways. Ohne offene Session (gid null)
  // laufen alle Zugriffe wie bisher auf den Legacy-Schlüsseln.
  async _gid(teamId) { return await this.redis.get(K.gwSessionId(teamId)); }

  // Lesen: neuer g:-Schlüssel gewinnt, sonst Altbestand (Deploy-Überleben).
  async _readMech(gKey, legacyKey) {
    const v = await this.redis.get(gKey);
    return (v !== null && v !== undefined) ? v : await this.redis.get(legacyKey);
  }
  // Vor dem Schreiben: Altbestand einmalig in den g:-Namespace verschieben,
  // damit es je Wert genau EINE Quelle gibt (nie beide addieren/lesen).
  async _migrateKey(gKey, legacyKey) {
    const cur = await this.redis.get(gKey);
    if (cur !== null && cur !== undefined) return;
    const legacy = await this.redis.get(legacyKey);
    if (legacy !== null && legacy !== undefined) {
      await this.redis.set(gKey, legacy);
      await this.redis.del(legacyKey);
    }
  }

  // ── Phase 2c: aktive Giveaways eines Teams ──────────────
  // Primary = Legacy-Zustand (auch ohne Session-ID, Altbestand/Tests);
  // Sekundär-Instanzen aus dem gwSet mit eigenem open/paused/Kanalliste.
  // channels null = alle Team-Kanäle.
  async _activeGiveaways(teamId) {
    const t = sanitizeTeamId(teamId);
    const out = [];
    const legacySid = await this.redis.get(K.gwSessionId(t));
    if (await this.redis.get(K.gwOpen(t)) === 'true' && await this.redis.get(K.gwPaused(t)) !== 'true') {
      out.push({ gid: legacySid || null, primary: true, core: CORE.id, channels: null });
    }
    for (const g of await this.redis.smembers(K.gwSet(t))) {
      if (g === legacySid) continue;   // Primary ist schon drin
      if (await this.redis.get(K.gOpen(t, g)) !== 'true') continue;
      if (await this.redis.get(K.gPaused(t, g)) === 'true') continue;
      let chans = null;
      try { const raw = await this.redis.get(K.gChanList(t, g)); if (raw) chans = JSON.parse(raw); } catch { /* alle */ }
      out.push({ gid: g, primary: false,
                 core: await this.redis.get(K.gCore(t, g)) || CORE.id,
                 channels: Array.isArray(chans) && chans.length ? chans.map(sanitizeChannel).filter(Boolean) : null });
    }
    return out;
  }

  async getCoreId(teamId, gid) {
    if (!gid) return CORE.id;
    const t = sanitizeTeamId(teamId);
    if (gid === await this.redis.get(K.gwSessionId(t))) return CORE.id;   // Primary = Default-Core
    return await this.redis.get(K.gCore(t, gid)) || CORE.id;
  }

  // Schlüsselwahl: gid null = Legacy (kein Giveaway-Kontext).
  _kWatch(t, g, ch, u)  { return g ? K.gWatch(t, g, ch, u)  : K.chWatch(t, ch, u); }
  _kMsgs(t, g, ch, u)   { return g ? K.gMsgs(t, g, ch, u)   : K.chMsgs(t, ch, u); }
  _kChatTs(t, g, ch, u) { return g ? K.gChatTs(t, g, ch, u) : K.chChatTs(t, ch, u); }
  _kReg(t, g, u)        { return g ? K.gReg(t, g, u)        : K.gwRegistered(t, u); }

  // Nachricht zählt je Giveaway; Migration nur für das Primary (nur dort
  // kann Altbestand existieren).
  async _bumpMsgs(t, gid, ch, u, primaryGid) {
    const key = this._kMsgs(t, gid, ch, u);
    if (gid && gid === primaryGid) await this._migrateKey(key, K.chMsgs(t, ch, u));
    await this.redis.incr(key);
  }

  // gid optional (Phase 2c): ohne gid gilt der Legacy-/Primary-Zustand.
  async isOpen(teamId, gid = undefined)   { const t = sanitizeTeamId(teamId);
    if (gid && gid !== await this.redis.get(K.gwSessionId(t))) return await this.redis.get(K.gOpen(t, gid)) === 'true';
    return await this.redis.get(K.gwOpen(t)) === 'true'; }
  async isPaused(teamId, gid = undefined) { const t = sanitizeTeamId(teamId);
    if (gid && gid !== await this.redis.get(K.gwSessionId(t))) return await this.redis.get(K.gPaused(t, gid)) === 'true';
    return await this.redis.get(K.gwPaused(t)) === 'true'; }
  // Aktiv = offen UND nicht pausiert → nur dann läuft Accrual.
  async isActive(teamId, gid = undefined) {
    return await this.isOpen(teamId, gid) && !await this.isPaused(teamId, gid); }
  async setPaused(teamId, paused, gid = undefined) {
    const t = sanitizeTeamId(teamId);
    const primary = await this.redis.get(K.gwSessionId(t));
    if (gid && gid !== primary) {   // Sekundär-Instanz: nur deren Zustand
      if (paused) await this.redis.set(K.gPaused(t, gid), 'true');
      else await this.redis.del(K.gPaused(t, gid));
      return;
    }
    if (paused) await this.redis.set(K.gwPaused(t), 'true');
    else await this.redis.del(K.gwPaused(t));
  }
  async getSessionId(teamId){ return await this.redis.get(K.gwSessionId(sanitizeTeamId(teamId))); }
  async listOpenTeams()     { return await this.redis.smembers(K.openTeams()); }

  // User im Team + Reverse-Index (für Zuschauer-Statusseite) markieren.
  async _touchUser(teamId, username) {
    await this.redis.sadd(K.gwUsers(teamId), username);
    await this.redis.sadd(K.userTeams(username), teamId);
  }
  async getUserTeams(username) { return this.redis.smembers(K.userTeams(sanitizeUsername(username))); }

  // ── Presence / Tick ─────────────────────────────────────
  async handleViewerTick(teamId, channel, username, follows) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    if (!t || !u) return null;
    const ch = await this.resolveChannel(t, channel);
    if (!ch) return null;
    const now = Math.floor(Date.now() / 1000);
    await this.redis.set(K.chLastTick(t, ch, u), String(now), 'EX', 86400);
    await this.redis.set(K.chPulse(t, ch), String(now), 'EX', 86400);
    await this.redis.set(K.chPresent(t, ch, u), '1', 'EX', PRESENCE_TTL);
    if (follows !== undefined) await this.redis.set(K.chFollows(t, ch, u), follows ? '1' : '0');
    await this._touchUser(t, u);
    await this.redis.sadd(K.chIndex(t, ch), u);
    return null;
  }

  async tickPresentUsers() {
    const teams = await this.listOpenTeams();
    const updates = [];
    for (const t of teams) {
      // Phase 2c: ein Tick geht an JEDES aktive Giveaway des Teams, dessen
      // Kanalliste den Kanal enthält. Zustand (Presence/Bann/Follow) wird
      // einmal gelesen und verteilt — Redis-Last wächst nicht mit n (§6).
      const active = await this._activeGiveaways(t);
      if (!active.length) {
        const stillThere = await this.redis.get(K.gwOpen(t)) === 'true'
                        || (await this.redis.smembers(K.gwSet(t))).length > 0;
        if (!stillThere) await this.redis.srem(K.openTeams(), t);
        continue;   // pausiert: kein Accrual, bleibt offen
      }
      const channels = await this.getChannels(t);
      const multByGid = new Map();   // je Giveaway einmal lesen
      const baseByGid = new Map();   // Coin-Basis ist per-Giveaway (Copy-on-Open)
      for (const g of active) {
        multByGid.set(g.gid, await this.getMultiplier(t, g.gid));
        baseByGid.set(g.gid, await this.getCoinBaseSec(t, g.gid));
      }
      for (const ch of channels) {
        // Nur Cores mit Watchtime-Accrual (Sofortverlosung: accrual 'none').
        const targets = active.filter(g => (!g.channels || g.channels.includes(ch))
                                        && getCore(g.core).accrual !== 'none');
        if (!targets.length) continue;
        const users = await this.redis.smembers(K.chIndex(t, ch));
        for (const u of users) {
          if (await this.redis.get(K.gwBanned(t, u)) === '1') continue;
          if (!await this.redis.get(K.chPresent(t, ch, u))) continue;
          if (!this._followAllowed(await this.redis.get(K.chFollows(t, ch, u)))) continue;
          for (const g of targets) {
            const inc  = CORE.tickDelta({ tickSec: TICK_SEC, multiplier: multByGid.get(g.gid) });
            const wKey = this._kWatch(t, g.gid, ch, u);
            if (g.primary && g.gid) await this._migrateKey(wKey, K.chWatch(t, ch, u));
            const newSec = parseFloat(await this.redis.incrbyfloat(wKey, inc));
            await this._logEvent(t, u, 'tick', inc, g.gid, ch);
            updates.push({ teamId: t, giveawayId: g.gid, primary: g.primary, username: u,
                           channel: ch, watchSec: newSec, coins: coinsFromSec(newSec, baseByGid.get(g.gid)) });
          }
        }
      }
    }
    return updates;
  }

  // ── Chat ────────────────────────────────────────────────
  async handleChatMessage(teamId, channel, username, message, follows) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    if (!t || !u) return null;
    // Phase 2c: die Nachricht zählt für JEDES aktive Giveaway, dessen
    // Kanalliste den Kanal enthält. Rückgabe bleibt der Primary-Kontrakt
    // (Join-Reply/wt_update im Server); Sekundär-Instanzen buchen still.
    const active = await this._activeGiveaways(t);
    if (!active.length) return null;
    const primaryGid = await this.redis.get(K.gwSessionId(t));

    const ch = await this.resolveChannel(t, channel);
    if (!ch) return null;
    const cleanMsg = sanitizeStr(message, 500).trim();

    await this.redis.set(K.chPresent(t, ch, u), '1', 'EX', PRESENCE_TTL);
    if (follows !== undefined) await this.redis.set(K.chFollows(t, ch, u), follows ? '1' : '0');
    await this._touchUser(t, u);
    await this.redis.sadd(K.chIndex(t, ch), u);

    const targets = active.filter(g => !g.channels || g.channels.includes(ch));
    if (!targets.length) return null;

    // Phase 4b: Setz-Befehl (per Instanz konfigurierbar — WebUI/gWagerCmd).
    // Ein Kommando ist keine Chat-Aktivität: zählt weder als Nachricht noch
    // für den Bonus; es wird gebucht und direkt beantwortet.
    // Mehrere Los-Giveaways je Team sind erlaubt (ein Giveaway = ein Preis).
    // Die Preis-Nummer entscheidet, welche Instanz gemeint ist — nicht die
    // Reihenfolge der Liste; zwei Instanzen duerfen denselben Befehl haben.
    const tbTargets = targets.filter(g => g.gid && getCore(g.core).id === 'CORE_TicketBuy');
    for (const g of tbTargets) {
      const TB = getCore(g.core);
      const cmd = (await this.redis.get(K.gWagerCmd(t, g.gid))) || TB.config.wagerCmd.def;
      const w = TB.parseWager(cleanMsg, cmd);
      if (!w) continue;
      if (await this.redis.get(K.gwBanned(t, u)) === '1') return null;
      // Ein Giveaway = ein Preis: der Setz-Befehl waehlt die Instanz (darum
      // team-weit eindeutig, wagerCmdTaken), der Preis kommt aus der Instanz.
      const prizes = await this.listPrizes(t, { gid: g.gid });
      if (w.help) return { chatReply: TB.helpText(cmd, prizes), channel: ch };
      if (!prizes.length) return { chatReply: TB.wagerErrText(u, 'no_prize'), channel: ch };
      const res = await this.placeWager(t, g.gid, u, prizes[0].id, w.amount);
      if (res.error) return { chatReply: TB.wagerErrText(u, res.error, res), channel: ch };
      if (res.refunded !== undefined) {
        return { chatReply: TB.retractOkText({ username: u, prizeTitle: res.prizeTitle,
                 refunded: res.refunded, balance: res.balance }), channel: ch };
      }
      return { chatReply: TB.wagerOkText({ username: u, prizeTitle: res.prizeTitle,
               amount: res.amount, stake: res.stake, balance: res.balance }), channel: ch };
    }

    // Keyword-Anmeldung je Giveaway (Keyword kann je Instanz abweichen;
    // Primary nutzt den Legacy-Schlüssel).
    let regResult = null, matchedAny = false, cvConfirm = null, tbConfirm = null;
    for (const g of targets) {
      const kw = g.primary ? await this.redis.get(K.gwKeyword(t))
                           : await this.redis.get(K.gKw(t, g.gid));
      if (!matchesKeyword(cleanMsg, kw)) continue;
      // Sofortverlosung: das Keyword zählt NUR im offenen Anmeldefenster —
      // die Ziehung selbst macht der Streamer manuell (auch mehrere Fenster).
      if (g.gid && getCore(g.core).id === 'CORE_CurrentViewers') {
        const end = parseInt(await this.redis.get(K.gWinEnd(t, g.gid)), 10);
        if (!Number.isFinite(end) || end * 1000 < Date.now()) continue;
      }
      matchedAny = true;
      await this._bumpMsgs(t, g.gid, ch, u, primaryGid);
      const r = await this._tryRegister(t, u, username, g.gid);
      if (g.primary) regResult = r;
      // P6: Bestätigung der Instant-Anmeldung — bisher blieb sie stumm.
      else if (getCore(g.core).id === 'CORE_CurrentViewers' && r.isNew) cvConfirm = g;
      // Los-Giveaway: Opt-in bestätigen und den Setz-Befehl gleich mitsagen.
      else if (getCore(g.core).id === 'CORE_TicketBuy' && r.isNew) tbConfirm = g;
    }
    if (matchedAny) {
      if (!regResult && cvConfirm
          && await this.redis.get(K.gAnnounce(t, cvConfirm.gid)) !== 'false') {
        return { channel: ch,
          chatReply: `@${u} ⚡ Du bist bei der Sofortverlosung angemeldet — bleib im Stream, gezogen wird live!` };
      }
      if (!regResult && tbConfirm) {
        const tbCmd = (await this.redis.get(K.gWagerCmd(t, tbConfirm.gid)))
                   || getCore(tbConfirm.core).config.wagerCmd.def;
        return { channel: ch,
          chatReply: `@${u} 🎟 Du bist beim Los-Giveaway angemeldet — Lose setzen mit „${tbCmd} <anzahl>" oder auf der Setz-Seite.` };
      }
      return regResult;
    }

    if (await this.redis.get(K.gwBanned(t, u)) === '1') return null;
    // Msgs/Bonus nur für Cores mit Watchtime-Accrual — die Sofortverlosung
    // kennt weder Nachrichtenzähler noch Chat-Bonus.
    const accrualTargets = targets.filter(g => getCore(g.core).accrual !== 'none');
    for (const g of accrualTargets) await this._bumpMsgs(t, g.gid, ch, u, primaryGid);
    await this._detectAbuse(t, u, cleanMsg);   // Spam-Signale (flaggt, bannt nicht) — einmal je Nachricht

    if (!this._followAllowed(await this.redis.get(K.chFollows(t, ch, u)))) return { channel: ch, followed: false };

    // KI-Urteil einmal je Nachricht — die Chat-Regeln (Wortschwelle, Bonus,
    // Cooldown) sind seither per-Giveaway und werden je Instanz angewandt.
    const aiVerdict = this.aiJudge ? await this.aiJudge(t, cleanMsg) : null;

    const now = Math.floor(Date.now() / 1000);
    let primaryResult = null;
    for (const g of accrualTargets) {
      const chatCfg = await this.getChatConfig(t, g.gid);
      if (!chatCfg.enabled || !chatCfg.bonusSec) continue;  // Bonus für dieses Giveaway abgeschaltet
      const { meaningful, judgedBy } = CORE.chatMeaningful({
        message: cleanMsg, minWords: chatCfg.minWords, aiVerdict });
      if (!meaningful) continue;

      const chatKey = this._kChatTs(t, g.gid, ch, u);
      if (g.primary && g.gid) await this._migrateKey(chatKey, K.chChatTs(t, ch, u));   // Cooldown läuft weiter
      const lastTs = await this.redis.get(chatKey);
      if (lastTs && (now - parseInt(lastTs)) < chatCfg.cooldown) continue;   // Cooldown je Giveaway

      const mult = await this.getMultiplier(t, g.gid);
      const inc  = CORE.chatDelta({ bonusSec: chatCfg.bonusSec, multiplier: mult });
      await this.redis.set(chatKey, String(now), 'EX', 86400);
      const wKey = this._kWatch(t, g.gid, ch, u);
      if (g.primary && g.gid) await this._migrateKey(wKey, K.chWatch(t, ch, u));
      const newSec = parseFloat(await this.redis.incrbyfloat(wKey, inc));
      await this._logEvent(t, u, 'chat_bonus', inc, g.gid, ch);
      if (g.primary) {
        primaryResult = { added: inc, channel: ch, watchSec: newSec, judgedBy,
                          coins: coinsFromSec(newSec, await this.getCoinBaseSec(t, g.gid)) };
      }
    }
    return primaryResult;
  }

  // P1c: Kenntnisnahme/Zustimmung je Teilnehmeraktion protokollieren —
  // append-only, die ERSTE Aktion je (Session, Nutzer, Aktion) zählt
  // (UNIQUE + ON CONFLICT DO NOTHING). core/terms_version kommen aus der
  // sessions-Zeile: das ist die Fassung, die beim Start festgeschrieben wurde.
  async recordConsent(teamId, gid, username, action, source = 'chat') {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (!t || !u || !gid) return;
    try {
      const s = await this.pg.query(`SELECT core, terms_version FROM sessions WHERE id=$1`, [gid]);
      const core = (s.rows[0] && s.rows[0].core) || null;
      const tv   = s.rows[0] && Number.isFinite(parseInt(s.rows[0].terms_version, 10))
                 ? parseInt(s.rows[0].terms_version, 10) : null;
      await this.pg.query(`
        INSERT INTO participation_consents (team_id, session_id, core, username, action, terms_version, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (team_id, session_id, username, action) DO NOTHING`,
        [t, gid, core, u, action, tv, source]);
    } catch (e) { console.error('[WTE] recordConsent:', e.message); }
  }

  async _tryRegister(teamId, username, displayName, explicitGid = undefined) {
    // Opt-in per Keyword: JEDER kann sich anmelden (= Zustimmung Regeln).
    // Für den Lostopf zählt separat die Berechtigung (Follows + ≥2h Viewtime),
    // siehe getUserAggregate.eligible.
    const primary = await this._gid(teamId);
    const gid = explicitGid === undefined ? primary : explicitGid;
    const regKey = this._kReg(teamId, gid, username);
    if (gid && gid === primary) await this._migrateKey(regKey, K.gwRegistered(teamId, username));
    const already = await this.redis.get(regKey);
    await this.redis.set(regKey, '1');
    await this._touchUser(teamId, username);
    await this.pg.query(`
      INSERT INTO users (username, display) VALUES ($1, $2)
      ON CONFLICT (username) DO UPDATE SET display = EXCLUDED.display, last_seen = NOW()
    `, [username, sanitizeStr(displayName, 50) || username]);
    if (!already) await this.recordConsent(teamId, gid, username, 'register', 'chat');
    const agg = await this.getUserAggregate(teamId, username, gid);
    return { ...agg, registered: true, isNew: !already };
  }

  // P6: Teilnahme selbst zurückziehen (Kampagne/Sofortverlosung) — entfernt
  // nur das Opt-in. Zuschauzeit/Coins bleiben Messwerte und laufen weiter;
  // ohne erneutes Keyword kommt die Person aber nicht mehr in den Lostopf.
  async unregisterUser(teamId, username, explicitGid = undefined) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (!t || !u) return { error: 'bad_request' };
    const primary = await this._gid(t);
    const gid = explicitGid === undefined ? primary : explicitGid;
    const regKey = this._kReg(t, gid, u);
    if (gid && gid === primary) await this._migrateKey(regKey, K.gwRegistered(t, u));
    if (!await this.redis.get(regKey)) return { error: 'not_registered' };
    await this.redis.del(regKey);
    return { ok: true, giveawayId: gid || null };
  }

  async registerUser(teamId, username) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    if (!t || !u) return null;
    const gid = await this._gid(t);
    await this.redis.set(gid ? K.gReg(t, gid, u) : K.gwRegistered(t, u), '1');
    await this._touchUser(t, u);
    await this.pg.query(`INSERT INTO users (username, display) VALUES ($1,$1)
                         ON CONFLICT (username) DO UPDATE SET last_seen = NOW()`, [u]);
    return { registered: true };
  }

  async adjustWatch(teamId, username, channel, deltaSec) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    if (!t || !u) return null;
    const ch = await this.resolveChannel(t, channel);
    const sid = await this.redis.get(K.gwSessionId(t));
    await this._touchUser(t, u);
    await this.redis.sadd(K.chIndex(t, ch), u);
    const wKey = sid ? K.gWatch(t, sid, ch, u) : K.chWatch(t, ch, u);
    if (sid) await this._migrateKey(wKey, K.chWatch(t, ch, u));
    let after = parseFloat(await this.redis.incrbyfloat(wKey, deltaSec));
    if (after < 0) { await this.redis.set(wKey, '0'); after = 0; }
    await this._logEvent(t, u, deltaSec >= 0 ? 'admin_add' : 'admin_sub', deltaSec, sid, ch);
    return { username: u, channel: ch, watchSec: after };
  }

  async setBanned(teamId, username, banned) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (!t || !u) return;
    if (banned) await this.redis.set(K.gwBanned(t, u), '1');
    else await this.redis.del(K.gwBanned(t, u));
  }

  // ── Aggregation ─────────────────────────────────────────
  // Engine sammelt Rohdaten aus Redis, der Core rechnet die Regeln
  // (Coins, Eligibility) — CORE.aggregate ist die zentrale Regelfunktion.
  // explicitGid: Stand eines bestimmten Giveaways; Default = Primary.
  // Legacy-Fallback nur für das Primary — Sekundär-Instanzen lesen strikt
  // ihren eigenen Namespace (kein Altbestand leakt hinein).
  async getUserAggregate(teamId, username, explicitGid = undefined) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    const channels = await this.getChannels(t);
    const primary = await this._gid(t);
    const gid = explicitGid === undefined ? primary : explicitGid;
    const strict = !!(gid && primary && gid !== primary);
    const rd = (gKey, lKey) => !gid ? this.redis.get(lKey)
                             : strict ? this.redis.get(gKey)
                             : this._readMech(gKey, lKey);
    const perChannelRaw = {};
    for (const ch of channels) {
      perChannelRaw[ch] = {
        watchSec: parseFloat((await rd(K.gWatch(t, gid, ch, u), K.chWatch(t, ch, u))) || '0'),
        msgs:     parseInt((await rd(K.gMsgs(t, gid, ch, u), K.chMsgs(t, ch, u))) || '0'),
        // Follow-Gate STRIKT: nur bestätigte Follows (Live-Event '1' oder Helix) zählen.
        // (Viewtime-Accrual bleibt permissiv, siehe tickPresentUsers.)
        // Follows bleiben team-weit — Eigenschaft des Zuschauers, nicht des Giveaways.
        follows:  (await this.redis.get(K.chFollows(t, ch, u))) === '1',
      };
    }
    return CORE.aggregate({
      username: u,
      perChannelRaw,
      registered: (await rd(K.gReg(t, gid, u), K.gwRegistered(t, u))) === '1',
      banned:     await this.redis.get(K.gwBanned(t, u)) === '1',
      cfg: {
        coinBaseSec: await this.getCoinBaseSec(t, gid),
        followMin:   await this.getFollowMin(t, gid),
      },
    });
  }
  async getUserState(teamId, username) { return this.getUserAggregate(teamId, username); }

  async getAllParticipants(teamId, explicitGid = undefined) {
    const t = sanitizeTeamId(teamId);
    const users = await this.redis.smembers(K.gwUsers(t));
    const result = [];
    for (const u of users) result.push(await this.getUserAggregate(t, u, explicitGid));
    const flags = await this.getFlagsMap(t);
    for (const p of result) p.flags = flags[p.username] || [];
    return result.sort((a, b) => b.totalCoins - a.totalCoins);
  }

  async _logEvent(teamId, username, eventType, deltaSec, sessionId, channel) {
    try {
      await this.pg.query(`
        INSERT INTO watchtime_events (username, event_type, delta_sec, session_id, channel, team_id)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [username, eventType, Math.round(deltaSec), sessionId || null, channel || null, teamId || null]);
    } catch(e) { console.error('[WTE] PG log error:', e.message); }
  }

  // ── Anti-Abuse: flaggen (append-only Audit, mit Beweis) ──
  // Upsert pro (team,user,reason): Zähler hoch, last_seen + Beweis aktualisiert.
  // Bannt NICHT — nur Markierung für Owner-Entscheidung (§5/§6 Ermessen).
  async flagUser(teamId, username, reason, detail) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (!t || !u) return;
    const sid = await this.redis.get(K.gwSessionId(t));
    if (!sid) return;   // ohne laufende Session kein Flag (Chat zählt eh nur aktiv)
    try {
      await this.pg.query(`
        INSERT INTO abuse_flags (session_id, team_id, username, reason, occurrences, first_seen, last_seen, detail)
        VALUES ($1,$2,$3,$4,1,NOW(),NOW(),$5)
        ON CONFLICT (session_id, username, reason) DO UPDATE SET
          occurrences = abuse_flags.occurrences + 1, last_seen = NOW(), detail = $5
      `, [sid, t, u, reason, JSON.stringify(detail || {})]);
    } catch(e) { console.error('[WTE] flag error:', e.message); }
  }

  // Spam-Signale aus dem Nachrichtenverlauf (deterministisch, reproduzierbar).
  async _detectAbuse(teamId, username, msg) {
    const t = teamId, u = username;
    const norm = String(msg).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm) return;
    const hash = createHash('sha1').update(norm).digest('hex').slice(0, 16);
    const now = Math.floor(Date.now() / 1000);
    const recent = await this.redis.lrange(K.abuseHist(t, u), 0, ABUSE.HIST_LEN - 1);
    const dupCount = recent.filter(h => h === hash).length + 1;
    await this.redis.lpush(K.abuseHist(t, u), hash);
    await this.redis.ltrim(K.abuseHist(t, u), 0, ABUSE.HIST_LEN - 1);
    await this.redis.lpush(K.abuseTimes(t, u), String(now));
    await this.redis.ltrim(K.abuseTimes(t, u), 0, ABUSE.TIMES_LEN - 1);
    const times = (await this.redis.lrange(K.abuseTimes(t, u), 0, ABUSE.TIMES_LEN - 1)).map(Number);
    const rate = times.filter(ts => now - ts < ABUSE.RATE_WINDOW).length;
    const all = recent.concat(hash);
    const distinct = new Set(all).size;

    if (dupCount >= ABUSE.DUP_MIN) await this.flagUser(t, u, 'dup_message', { message: String(msg).slice(0, 140), count: dupCount });
    if (rate > ABUSE.RATE_MAX) await this.flagUser(t, u, 'high_rate', { perWindow: rate, windowSec: ABUSE.RATE_WINDOW });
    if (all.length >= ABUSE.DIV_MIN_MSGS && distinct / all.length < ABUSE.DIV_RATIO)
      await this.flagUser(t, u, 'low_diversity', { distinct, total: all.length });
  }

  // Alle Flags eines Teams als Map username → [{reason,count}].
  async getFlagsMap(teamId) {
    const t = sanitizeTeamId(teamId);
    const map = {};
    const sid = await this.redis.get(K.gwSessionId(t));
    if (!sid) return map;
    try {
      const r = await this.pg.query('SELECT username, reason, occurrences FROM abuse_flags WHERE session_id=$1', [sid]);
      for (const row of r.rows) (map[row.username] = map[row.username] || []).push({ reason: row.reason, count: row.occurrences });
    } catch(e) { console.error('[WTE] getFlagsMap:', e.message); }
    return map;
  }

  validateSessionId(id) {
    if (!id || typeof id !== 'string' || !/^sess_\d+$/i.test(id)) throw new Error('Invalid sessionId');
  }

  async openGiveaway(teamId, keyword, sessionId) {
    const t = sanitizeTeamId(teamId);
    this.validateSessionId(sessionId);
    if (!t) throw new Error('Invalid teamId');
    await this.redis.set(K.gwOpen(t), 'true');
    await this.redis.del(K.gwPaused(t));   // öffnen = aktiv (nicht pausiert)
    await this.redis.sadd(K.openTeams(), t);
    // Keyword ist persistent: nur überschreiben wenn beim Öffnen explizit
    // eins angegeben wird — sonst bestehendes behalten (Open/Close-Zyklen,
    // Restart). Ändern jederzeit über gw_set_keyword (auch bei laufendem GW).
    if (keyword) await this.redis.set(K.gwKeyword(t), keyword);
    await this.redis.set(K.gwSessionId(t), sessionId);
    // Phase 2c: das Primary steht auch im Giveaway-Set (Spiegel), damit
    // die Verteilung nur eine Quelle für "aktive Giveaways" kennt.
    await this.redis.sadd(K.gwSet(t), sessionId);
    await this.redis.set(K.gOpen(t, sessionId), 'true');
    await this.redis.del(K.gPaused(t, sessionId));
    // Team-Vorgaben werden die eigenen Werte dieses Giveaways (Copy-on-Open).
    await this.copyCfgToInstance(t, sessionId);
    await this.redis.del(K.gwChannels(t)); // Kanal-Cache invalidieren
    console.log(`[WTE] [${t}] opened, keyword="${keyword}", session=${sessionId}`);
  }

  // ── Phase 2c: Sekundär-Instanz (z.B. Sofortverlosung neben der Kampagne) ──
  // Läuft ausschließlich im g:-Namespace; channels = Teilmenge der
  // Team-Kanäle (leer/null = alle).
  async openGiveawayInstance(teamId, gid, { keyword = '', channels = null, core = null, windowSec = 0, wagerCmd = '', minWatchSec = null, announce = true, name = '' } = {}) {
    const t = sanitizeTeamId(teamId);
    this.validateSessionId(gid);
    if (!t) throw new Error('Invalid teamId');
    // Der Contest hat eine Zuschauer-Seite, die die Instanz über das Team
    // findet — zwei parallele Contests wären dort nicht unterscheidbar.
    // Darum: maximal einer je Team. Los-Giveaways dürfen parallel laufen
    // (ein Giveaway = ein Preis); die Setz-Seite listet sie einzeln auf.
    if (core === 'CORE_ScreenshotContest') {
      const dup = (await this.listGiveaways(t)).find(g => !g.primary && g.core === core);
      if (dup) throw new Error('duplicate_core');
    }
    await this.redis.sadd(K.gwSet(t), gid);
    await this.redis.set(K.gOpen(t, gid), 'true');
    await this.redis.del(K.gPaused(t, gid));
    if (keyword) await this.redis.set(K.gKw(t, gid), sanitizeStr(keyword, 100));
    if (Array.isArray(channels) && channels.length) {
      await this.redis.set(K.gChanList(t, gid), JSON.stringify(channels.map(sanitizeChannel).filter(Boolean)));
    }
    // Phase 3: Instanz kann einen anderen Core fahren; Sofortverlosungen
    // tragen ihr Fensterende, der Server-Watcher zieht danach automatisch.
    if (core && core !== CORE.id) await this.redis.set(K.gCore(t, gid), sanitizeStr(core, 60));
    const win = parseInt(windowSec, 10);
    if (Number.isFinite(win) && win > 0) {
      await this.redis.set(K.gWinEnd(t, gid), String(Math.floor(Date.now() / 1000) + win));
    }
    if (wagerCmd) await this.redis.set(K.gWagerCmd(t, gid), sanitizeStr(wagerCmd, 30).toLowerCase());
    if (minWatchSec !== null && Number.isFinite(parseInt(minWatchSec, 10))) {
      await this.redis.set(K.gMinWatch(t, gid), String(Math.max(0, parseInt(minWatchSec, 10))));
    }
    // Chat-Ansagen abschaltbar (Sofortverlosung): nur die Abweichung speichern.
    if (announce === false) await this.redis.set(K.gAnnounce(t, gid), 'false');
    if (name) await this.redis.set(K.gName(t, gid), sanitizeStr(name, 40).trim());
    // Copy-on-Open nur für Mechaniken mit Watchtime-Accrual — die anderen
    // lesen diese Werte nie.
    if (getCore(core).accrual !== 'none') await this.copyCfgToInstance(t, gid);
    await this.redis.sadd(K.openTeams(), t);
    console.log(`[WTE] [${t}] instance ${gid} opened, core=${core || CORE.id}, keyword="${keyword}"`);
  }

  // ── Phase 3: Teilnehmer einer Sofortverlosung ───────────
  // Berechtigt = Keyword geschrieben (gReg) UND als Zuschauer gemeldet:
  // viewer_tick (chLastTick) innerhalb PRESENCE_TTL auf einem Instanz-Kanal.
  // Chat setzt chPresent, aber NICHT chLastTick — wer nur den Chat offen
  // hat, gilt hier nicht als anwesend (§5.3).
  async getInstantParticipants(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    let channels = null;
    try { const raw = await this.redis.get(K.gChanList(t, gid)); if (raw) channels = JSON.parse(raw); } catch { /* alle */ }
    if (!Array.isArray(channels) || !channels.length) channels = await this.getChannels(t);
    const core = getCore(await this.getCoreId(t, gid));
    // Schwellen der Instanz: Mindest-Zuschauzeit (Default aus dem Core) und
    // Follow-Pflicht. Beide lesen den Kampagnenstand des Teams — die
    // Sofortverlosung sammelt selbst keine Zeit (accrual 'none').
    const rawMin = await this.redis.get(K.gMinWatch(t, gid));
    const minWatchSec = Number.isFinite(parseInt(rawMin, 10))
      ? parseInt(rawMin, 10)
      : (core.config && core.config.minWatchSec ? core.config.minWatchSec.def : 0);
    const cfg = { minWatchSec, followRequired: true };
    const now = Math.floor(Date.now() / 1000);
    const result = [];
    for (const u of await this.redis.smembers(K.gwUsers(t))) {
      const registered = await this.redis.get(K.gReg(t, gid, u)) === '1';
      if (!registered) continue;   // ohne Keyword-Opt-in nie im Topf
      let present = false;
      for (const ch of channels) {
        const ts = parseInt(await this.redis.get(K.chLastTick(t, ch, u)), 10);
        if (Number.isFinite(ts) && now - ts < PRESENCE_TTL) { present = true; break; }
      }
      // Zuschauzeit + Follow aus dem Team-/Kampagnenstand, nur auf den
      // Kanaelen dieser Instanz.
      const agg = await this.getUserAggregate(t, u);
      let watchSec = 0, follows = false;
      for (const ch of channels) {
        const pc = agg.perChannel[ch];
        if (!pc) continue;
        watchSec += pc.watchSec || 0;
        if (pc.follows) follows = true;
      }
      result.push(core.aggregate({
        username: u, registered,
        banned: await this.redis.get(K.gwBanned(t, u)) === '1',
        present, watchSec, follows, cfg,
      }));
    }
    return result;
  }

  // Ingest-Puls je Kanal: wann kam zuletzt ein viewer_tick an und wie viele
  // Zuschauer sind gerade als anwesend markiert. `stale` = laenger als
  // PRESENCE_TTL still — dann kann die Sofortverlosung niemanden ziehen.
  async getIngestPulse(teamId, channels = null) {
    const t = sanitizeTeamId(teamId);
    const chans = Array.isArray(channels) && channels.length ? channels : await this.getChannels(t);
    const now = Math.floor(Date.now() / 1000);
    // Live-Kanaele laut stream_online/-offline. Ohne laufenden Stream sendet
    // Streamerbot bewusst nichts (beide Actions pruefen ObsIsStreaming) —
    // fehlende Ticks sind dann normal und keine Stoerung.
    const online = new Set(await this.redis.smembers(K.gwOnline(t)));
    const out = [];
    for (const ch of chans) {
      const ts = parseInt(await this.redis.get(K.chPulse(t, ch)), 10);
      let present = 0;
      for (const u of await this.redis.smembers(K.chIndex(t, ch))) {
        const last = parseInt(await this.redis.get(K.chLastTick(t, ch, u)), 10);
        if (Number.isFinite(last) && now - last < PRESENCE_TTL) present++;
      }
      const silent = !Number.isFinite(ts) || now - ts >= PRESENCE_TTL;
      out.push({ channel: ch, lastTickAgo: Number.isFinite(ts) ? now - ts : null, present,
                 online: online.has(ch), silent,
                 // stale = echter Stoerfall: Stream laeuft, es kommt trotzdem nichts.
                 stale: silent && online.has(ch) });
    }
    return out;
  }

  // P6: Teilnehmer-Vorschau VOR dem Start — wie viele Zuschauer würden die
  // Bedingungen der Mechanik jetzt erfüllen. Reine Schätzung auf dem
  // Team-/Kampagnenstand (bzw. Präsenz/Guthaben), ohne Opt-in-Anteil.
  async previewEligible(teamId, { core = 'CORE_WatchtimeChatActivity', channels = null, minWatchSec = 0 } = {}) {
    const t = sanitizeTeamId(teamId);
    const chans = Array.isArray(channels) && channels.length ? channels : await this.getChannels(t);
    if (core === 'CORE_CurrentViewers') {
      // Wer koennte JETZT mitmachen: Follow auf einem gewaehlten Kanal und
      // genug Zuschauzeit. Das Keyword kommt erst im Anmeldefenster dazu.
      const minW = minWatchSec || 0;
      let n = 0;
      for (const u of await this.redis.smembers(K.gwUsers(t))) {
        if (await this.redis.get(K.gwBanned(t, u)) === '1') continue;
        const agg = await this.getUserAggregate(t, u);
        let w = 0, f = false;
        for (const ch of chans) {
          const pc = agg.perChannel[ch];
          if (!pc) continue;
          w += pc.watchSec || 0;
          if (pc.follows) f = true;
        }
        if (f && w >= minW) n++;
      }
      return { count: n, basis: 'present', minWatchSec: minWatchSec || 0 };
    }
    if (core === 'CORE_TicketBuy') {
      // Konten mit positivem Ledger-Saldo (Live-Anteil entsteht erst im Lauf).
      const r = await this.pg.query(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT username FROM credit_ledger WHERE team_id=$1
          GROUP BY username HAVING SUM(amount) > 0) x`, [t]);
      return { count: (r.rows[0] && r.rows[0].n) || 0, basis: 'credit' };
    }
    const parts = await this.getAllParticipants(t);   // Kampagnen-/Legacy-Stand
    if (core === 'CORE_ScreenshotContest') {
      const n = parts.filter(p => !p.banned
        && chans.some(ch => p.perChannel[ch] && p.perChannel[ch].follows)
        && p.totalWatchSec >= (minWatchSec || 0)).length;
      return { count: n, basis: 'contest', minWatchSec: minWatchSec || 0 };
    }
    const followMin = await this.getFollowMin(t);
    const n = parts.filter(p => !p.banned
      && p.channelsQualified >= followMin && p.totalCoins >= 1).length;
    return { count: n, basis: 'campaign', followMin };
  }

  // ── Panel-Teilnehmerlisten je Mechanik (CORE.display) ───
  // TicketBuy: wer Guthaben hält oder gesetzt hat. balance ist team-weit
  // (§10.1, wandert mit), stake gilt je Instanz; eligible = ≥1 Los gesetzt.
  async getTicketBuyParticipants(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    const round4 = (x) => Math.round((parseFloat(x) || 0) * 10000) / 10000;
    const row0 = (u) => ({ username: u, balance: 0, stake: 0, watchSec: 0, reg: false });
    const map = new Map();
    const bal = await this.pg.query(
      `SELECT username, SUM(amount) AS balance FROM credit_ledger WHERE team_id=$1 GROUP BY username`, [t]);
    for (const r of bal.rows) { const row = row0(r.username); row.balance = round4(r.balance); map.set(r.username, row); }
    const st = await this.pg.query(
      `SELECT w.username, SUM(w.amount) AS stake
       FROM prize_wagers w JOIN giveaway_prizes p ON p.id = w.prize_id
       WHERE p.team_id=$1 AND p.session_id=$2 GROUP BY w.username`, [t, gid]);
    for (const r of st.rows) {
      const row = map.get(r.username) || row0(r.username);
      row.stake = round4(r.stake);
      map.set(r.username, row);
    }
    // Anmeldung = Keyword-Opt-in der Instanz (18.8.26) + Instanz-Viewtime.
    // Instanzen ohne Keyword (Altbestand) bleiben permissiv: Einsatz gilt
    // dort weiter als Teilnahme.
    const kw = await this.redis.get(K.gKw(t, gid));
    let channels = null;
    try { const raw = await this.redis.get(K.gChanList(t, gid)); if (raw) channels = JSON.parse(raw); } catch { /* alle */ }
    if (!Array.isArray(channels) || !channels.length) channels = await this.getChannels(t);
    for (const u of await this.redis.smembers(K.gwUsers(t))) {
      const reg = kw ? (await this.redis.get(K.gReg(t, gid, u))) === '1' : false;
      let sec = 0;
      for (const ch of channels) sec += parseFloat(await this.redis.get(K.gWatch(t, gid, ch, u)) || '0');
      if (!reg && sec <= 0 && !map.has(u)) continue;
      const row = map.get(u) || row0(u);
      row.reg = reg; row.watchSec = Math.round(sec);
      map.set(u, row);
    }
    // Letzte 3 echte Ziehungen team-weit (alle Mechaniken, inkl. Ersatz-
    // ziehungen) — Markierung im Ticketstand. Nur Beiwerk: Fehler hier
    // dürfen die Liste nicht verhindern.
    const recent = new Map();
    try {
      const d = await this.pg.query(
        `SELECT d.winner, d.prize, d.drawn_at
         FROM giveaway_draws d JOIN sessions s ON s.id = d.session_id
         WHERE s.team_id=$1 AND NOT d.is_test
         ORDER BY d.drawn_at DESC, d.id DESC LIMIT $2`, [t, 3]);
      d.rows.forEach((r, i) => {
        if (!recent.has(r.winner)) recent.set(r.winner, { rank: i + 1, prize: r.prize || '', at: r.drawn_at });
      });
    } catch { /* keine Markierung */ }
    const out = [];
    for (const row of map.values()) {
      const registered = row.reg || (!kw && row.stake > 0);
      // „Tatsächliche Lose" = Ledger-Saldo + live erspielter Stand laufender
      // TicketBuy-Instanzen (dieselbe Formel wie availableCredit/earn).
      const lose = round4(row.balance + await this._liveTicketBuyCredit(t, row.username));
      if (row.balance <= 0 && row.stake <= 0 && !registered && lose <= 0) continue;
      out.push({ username: row.username, balance: row.balance, stake: row.stake,
        watchSec: row.watchSec, lose, recentWin: recent.get(row.username) || null,
        banned: await this.redis.get(K.gwBanned(t, row.username)) === '1',
        registered, eligible: row.stake > 0 });
    }
    return out.sort((a, b) => b.stake - a.stake || b.lose - a.lose);
  }

  // Contest: Einsender mit Status/Punkten — dieselben Zahlen wie die
  // Einsendungs-Karte, nur als Teilnehmerliste fürs Dashboard.
  async getContestParticipants(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    const out = [];
    for (const s of await this.getContestStandings(t, gid, { all: true })) {
      out.push({ username: s.username, entryId: s.entryId,
        title: s.title || ('#' + s.entryId),
        status: s.status, score: s.score, votes: s.votes,
        banned: await this.redis.get(K.gwBanned(t, s.username)) === '1',
        registered: true, eligible: s.status === 'approved' });
    }
    return out;
  }

  // Alle offenen Giveaways (inkl. pausierter) mit Metadaten — fürs Panel.
  // stats:true ergänzt Startzeit + Teilnehmerzahl (nur fürs Auswahl-Dropdown;
  // die vielen internen Aufrufer zahlen die PG-Queries nicht mit).
  async listGiveaways(teamId, { stats = false } = {}) {
    const t = sanitizeTeamId(teamId);
    const out = [];
    const legacySid = await this.redis.get(K.gwSessionId(t));
    if (await this.redis.get(K.gwOpen(t)) === 'true') {
      out.push({ gid: legacySid || null, primary: true, core: CORE.id,
                 paused: await this.redis.get(K.gwPaused(t)) === 'true',
                 keyword: await this.redis.get(K.gwKeyword(t)) || '',
                 channels: null, windowEndsAt: null });
    }
    for (const g of await this.redis.smembers(K.gwSet(t))) {
      if (g === legacySid) continue;
      // Geschlossene Instanzen bleiben in der Liste, bis gezogen/aufgeraeumt
      // wurde — sonst waere der Topf nach dem Schliessen unerreichbar.
      const isOpen = await this.redis.get(K.gOpen(t, g)) === 'true';
      let chans = null;
      try { const raw = await this.redis.get(K.gChanList(t, g)); if (raw) chans = JSON.parse(raw); } catch { /* alle */ }
      out.push({ gid: g, primary: false, closed: !isOpen,
                 core: await this.redis.get(K.gCore(t, g)) || CORE.id,
                 paused: await this.redis.get(K.gPaused(t, g)) === 'true',
                 keyword: await this.redis.get(K.gKw(t, g)) || '',
                 channels: Array.isArray(chans) && chans.length ? chans : null,
                 windowEndsAt: parseInt(await this.redis.get(K.gWinEnd(t, g)), 10) || null,
                 announce: await this.redis.get(K.gAnnounce(t, g)) !== 'false',
                 name: await this.redis.get(K.gName(t, g)) || '' });
    }
    if (stats) {
      const gids = out.map(g => g.gid).filter(Boolean);
      const starts = {};
      if (gids.length) {
        try {
          const r = await this.pg.query(
            `SELECT id, opened_at, prize, sponsor FROM sessions WHERE team_id=$1 AND id = ANY($2)`, [t, gids]);
          for (const row of r.rows) if (row.id) starts[row.id] = row;
        } catch { /* Anzeige-Metadaten — nie blockierend */ }
      }
      for (const g of out) {
        const row = starts[g.gid] || null;
        g.startedAt = row ? row.opened_at : null;
        g.prize     = row ? row.prize   : null;
        g.sponsor   = row ? row.sponsor : null;
        g.participants = await this._participantCount(t, g);
      }
    }
    return out;
  }

  // Teilnehmerzahl fürs Dropdown, je Mechanik: Setzer (TicketBuy),
  // Einsender (Contest), sonst Angemeldete (Keyword-Opt-in).
  async _participantCount(t, g) {
    try {
      if (g.core === 'CORE_TicketBuy') {
        return (await this.getTicketBuyParticipants(t, g.gid)).filter(p => p.eligible).length;
      }
      if (g.core === 'CORE_ScreenshotContest') {
        const r = await this.pg.query(
          `SELECT COUNT(*)::int AS cnt FROM contest_entries WHERE session_id=$1 AND team_id=$2`, [g.gid, t]);
        return parseInt(r.rows[0] && r.rows[0].cnt, 10) || 0;
      }
      let n = 0;
      for (const u of await this.redis.smembers(K.gwUsers(t))) {
        const reg = g.gid ? await this.redis.get(K.gReg(t, g.gid, u)) === '1' : false;
        if (reg || (g.primary && await this.redis.get(K.gwRegistered(t, u)) === '1')) n++;
      }
      return n;
    } catch { return null; }
  }

  // Sofortverlosung: (weiteres) Anmeldefenster öffnen. Teilnehmer aus
  // früheren Fenstern bleiben angemeldet (gReg akkumuliert).
  async openInstantWindow(teamId, gid, windowSec) {
    const t = sanitizeTeamId(teamId);
    const sec = Math.max(10, Math.min(3600, parseInt(windowSec, 10) || 60));
    const endsAt = Math.floor(Date.now() / 1000) + sec;
    await this.redis.set(K.gWinEnd(t, gid), String(endsAt));
    return { windowSec: sec, endsAt };
  }

  // SCHLIESSEN heisst: Sammeln/Anmelden ist vorbei — der Topf bleibt.
  // Reihenfolge fuer ALLE Mechaniken (Betreiber 9.8.26):
  // schliessen → ziehen → aufraeumen. Die Instanz bleibt darum in
  // `gwSet` (Zustand bleibt lesbar, Panel kann sie waehlen und ziehen);
  // erst `cleanupGiveawayInstance` entfernt sie endgueltig.
  async closeGiveawayInstance(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    await this.redis.set(K.gOpen(t, gid), 'false');
    await this.redis.del(K.gWinEnd(t, gid));   // ein offenes Anmeldefenster endet mit
    if (!(await this._activeGiveaways(t)).length && await this.redis.get(K.gwOpen(t)) !== 'true') {
      await this.redis.srem(K.openTeams(), t);
    }
    console.log(`[WTE] [${t}] instance ${gid} closed (Topf bleibt bis zur Ziehung)`);
  }

  // Geschlossen, aber noch nicht aufgeraeumt → Sammeln/Anmelden darf wieder
  // aufmachen (Betreiber 18.8.26). TicketBuy: das Guthaben ist beim Schliessen
  // schon ins Ledger gewandert (settleTicketBuyInstance) — die verbrauchten
  // Zeitstaende muessen darum VOR dem Weitersammeln auf null, sonst wuerde
  // das naechste Schliessen dieselben Sekunden noch einmal gutschreiben.
  async reopenGiveawayInstance(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    if (await this.getCoreId(t, gid) === 'CORE_TicketBuy') {
      let channels = null;
      try { const raw = await this.redis.get(K.gChanList(t, gid)); if (raw) channels = JSON.parse(raw); } catch { /* alle */ }
      if (!Array.isArray(channels) || !channels.length) channels = await this.getChannels(t);
      for (const u of await this.redis.smembers(K.gwUsers(t))) {
        for (const ch of channels) await this.redis.del(K.gWatch(t, gid, ch, u));
      }
    }
    await this.redis.set(K.gOpen(t, gid), 'true');
    await this.redis.sadd(K.openTeams(), t);
    console.log(`[WTE] [${t}] instance ${gid} reopened`);
  }

  // ── Phase 4b: CORE_TicketBuy — Preise, Einsätze, Guthaben ──
  // Ein Giveaway verlost genau EINEN Preis: ein zweiter offener Preis in
  // derselben Instanz waere ein zweites Giveaway im ersten. Wer mehr
  // verlosen will, startet ein weiteres Los-Giveaway.
  async addPrize(teamId, gid, { title, description = '', wagerEndTs = null } = {}) {
    const t = sanitizeTeamId(teamId);
    // Auch NACH der Ziehung bleibt der Platz belegt — der naechste Preis ist
    // ein neues Los-Giveaway. Nur Storno macht den Platz wieder frei.
    if (gid) {
      const r0 = await this.pg.query(
        `SELECT COUNT(*) AS n FROM giveaway_prizes WHERE team_id=$1 AND session_id=$2 AND status <> 'cancelled'`,
        [t, gid]);
      if ((parseInt(r0.rows[0].n, 10) || 0) > 0) throw new Error('prize_exists');
    }
    const r = await this.pg.query(
      `INSERT INTO giveaway_prizes (team_id, session_id, title, description, wager_end)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [t, gid || null, sanitizeStr(title, 100), sanitizeStr(description, 500),
       wagerEndTs ? new Date(wagerEndTs * 1000) : null]);
    return r.rows[0].id;
  }

  // gid gesetzt = nur die Preise DIESER Instanz (seit ein Team mehrere
  // Los-Giveaways parallel fahren darf). Ohne gid: alle Preise des Teams.
  async listPrizes(teamId, { openOnly = true, gid = null } = {}) {
    const t = sanitizeTeamId(teamId);
    const args = [t];
    let where = 'p.team_id=$1';
    if (gid) { args.push(gid); where += ` AND p.session_id=$${args.length}`; }
    if (openOnly) where += ` AND p.status='open'`;
    const r = await this.pg.query(
      `SELECT p.id, p.session_id, p.title, p.description, p.wager_end, p.status, p.sponsor,
              (p.image IS NOT NULL) AS has_image, p.image_token,
              COALESCE((SELECT SUM(w.amount) FROM prize_wagers w WHERE w.prize_id = p.id), 0) AS total_stake
       FROM giveaway_prizes p WHERE ` + where + ` ORDER BY p.id`, args);
    return r.rows;
  }

  // Seit "!setzen <anzahl>" routet der Setz-Befehl den Chat-Einsatz auf die
  // Instanz — er muss darum je Team unter den offenen Los-Giveaways eindeutig
  // sein. Prueft gegen die effektiven Befehle (konfiguriert oder Default).
  async wagerCmdTaken(teamId, cmd, excludeGid = null) {
    const t = sanitizeTeamId(teamId);
    const c = String(cmd || '').trim().toLowerCase();
    if (!c) return false;
    const def = getCore('CORE_TicketBuy').config.wagerCmd.def;
    for (const g of await this.listGiveaways(t)) {
      if (g.closed || !g.gid || g.gid === excludeGid) continue;
      if (getCore(g.core).id !== 'CORE_TicketBuy') continue;
      const eff = (await this.redis.get(K.gWagerCmd(t, g.gid))) || def;
      if (eff === c) return true;
    }
    return false;
  }

  // Instanz, zu der ein Preis gehoert — Prizes sind global nummeriert, die
  // Zuordnung darf nicht aus "erster TicketBuy-Instanz" geraten werden.
  async prizeGiveawayId(teamId, prizeId) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `SELECT session_id FROM giveaway_prizes WHERE id=$1 AND team_id=$2`, [prizeId, t]);
    return r.rowCount ? r.rows[0].session_id : null;
  }

  // Ungezogene Preise einer Instanz — Gate fürs Schließen (erst ziehen
  // oder stornieren, sonst stranden offene Preise ohne Core/Panel).
  async openPrizeCount(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `SELECT COUNT(*) AS n FROM giveaway_prizes WHERE team_id=$1 AND session_id=$2 AND status='open'`, [t, gid]);
    return parseInt(r.rows[0].n, 10) || 0;
  }

  // Preis korrigieren — nur solange er offen ist (nach Ziehung ist der
  // Ziehungssatz der Nachweis, da wird nichts mehr angefasst).
  async editPrize(teamId, prizeId, { title, sponsor, description, wagerEndTs } = {}) {
    const t = sanitizeTeamId(teamId);
    const pr = await this.pg.query(
      `SELECT id, status FROM giveaway_prizes WHERE id=$1 AND team_id=$2`, [prizeId, t]);
    if (!pr.rowCount) return { error: 'no_prize' };
    if (pr.rows[0].status !== 'open') return { error: 'not_open' };
    if (title !== undefined && title !== null && String(title).trim()) {
      await this.pg.query(`UPDATE giveaway_prizes SET title=$1 WHERE id=$2`, [sanitizeStr(String(title), 100).trim(), prizeId]);
    }
    if (sponsor !== undefined && sponsor !== null) {
      await this.pg.query(`UPDATE giveaway_prizes SET sponsor=$1 WHERE id=$2`,
        [sanitizeStr(String(sponsor), 100).trim() || null, prizeId]);
    }
    if (description !== undefined && description !== null) {
      await this.pg.query(`UPDATE giveaway_prizes SET description=$1 WHERE id=$2`,
        [sanitizeStr(String(description), 500).trim() || null, prizeId]);
    }
    if (wagerEndTs !== undefined) {   // null = Einsatz-Ende entfernen
      await this.pg.query(`UPDATE giveaway_prizes SET wager_end=$1 WHERE id=$2`,
        [wagerEndTs ? new Date(wagerEndTs * 1000) : null, prizeId]);
    }
    const out = await this.pg.query(
      `SELECT id, title, sponsor, description, wager_end, status FROM giveaway_prizes WHERE id=$1`, [prizeId]);
    return { prize: out.rows[0] };
  }

  // Preis stornieren: alle offenen Einsätze zurückbuchen (Gegenzeile in
  // prize_wagers + refund im Ledger — dieselben Primitiven wie die
  // freiwillige Rücknahme), dann status='cancelled'. Kein DELETE.
  // Atomar wie placeWager: FOR UPDATE auf dem Preis serialisiert gegen
  // gleichzeitiges Setzen/Zurücknehmen — sonst könnte eine parallele
  // Rücknahme denselben Einsatz doppelt erstatten.
  async cancelPrize(teamId, prizeId) {
    const t = sanitizeTeamId(teamId);
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const pr = await client.query(
        `SELECT id, title, status FROM giveaway_prizes WHERE id=$1 AND team_id=$2 FOR UPDATE`, [prizeId, t]);
      if (!pr.rowCount) { await client.query('ROLLBACK'); return { error: 'no_prize' }; }
      if (pr.rows[0].status !== 'open') { await client.query('ROLLBACK'); return { error: 'not_open' }; }
      const st = await client.query(
        `SELECT username, SUM(amount) AS stake FROM prize_wagers
         WHERE prize_id=$1 AND team_id=$2 GROUP BY username HAVING SUM(amount) > 0`, [prizeId, t]);
      const stakes = st.rows.map(x => ({ username: x.username, stake: Math.round(parseFloat(x.stake) * 10000) / 10000 }));
      let total = 0;
      for (const s of stakes) {
        await client.query(`INSERT INTO prize_wagers (prize_id, team_id, username, amount) VALUES ($1,$2,$3,$4)`,
          [prizeId, t, s.username, -s.stake]);
        await this.credit.book(t, s.username, 'refund', s.stake, { refPrize: prizeId, client });
        total += s.stake;
      }
      await client.query(`UPDATE giveaway_prizes SET status='cancelled' WHERE id=$1`, [prizeId]);
      await client.query('COMMIT');
      console.log(`[WTE] [${t}] prize ${prizeId} cancelled: ${stakes.length} Einsätze (+${total.toFixed(2)}) zurückgebucht`);
      return { title: pr.rows[0].title, refundedUsers: stakes.length,
               refundedTotal: Math.round(total * 10000) / 10000 };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* schon zu */ }
      throw e;
    } finally { client.release(); }
  }

  async prizeStake(prizeId, username) {
    const r = await this.pg.query(
      `SELECT COALESCE(SUM(amount),0) AS stake FROM prize_wagers WHERE prize_id=$1 AND username=$2`,
      [prizeId, username]);
    return Math.round((parseFloat(r.rows[0].stake) || 0) * 10000) / 10000;
  }

  // Verfügbares Guthaben = Ledger-Saldo + live erspielter Stand laufender
  // TicketBuy-Instanzen. Der Live-Anteil wird beim Close als earn gebucht
  // (settleTicketBuyInstance) — bis dahin darf der Ledger-Saldo durch
  // Einsätze entsprechend ins Minus gehen, die Summe bleibt ≥ 0.
  async _liveTicketBuyCredit(t, u) {
    let live = 0;
    for (const g of await this._activeGiveaways(t)) {
      if (getCore(g.core).id !== 'CORE_TicketBuy' || !g.gid) continue;
      const base = await this.getCoinBaseSec(t, g.gid);
      const channels = g.channels || await this.getChannels(t);
      let sec = 0;
      for (const ch of channels) sec += parseFloat(await this.redis.get(K.gWatch(t, g.gid, ch, u)) || '0');
      live += coinsFromSec(sec, base);
    }
    return live;
  }

  async availableCredit(teamId, username) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    const avail = await this.credit.balance(t, u) + await this._liveTicketBuyCredit(t, u);
    return Math.round(avail * 10000) / 10000;
  }

  // Einsatz setzen (amount ≥ 1) oder komplett zurücknehmen (amount === 0).
  // Bucht Ledger UND prize_wagers — beides append-only, eine Stelle.
  // ATOMAR (ChatGPT-Review #1): Kontostand-Prüfung und Buchung laufen in
  // EINER Transaktion. pg_advisory_xact_lock je (Team, Nutzer) serialisiert
  // parallele Requests desselben Kontos (sonst lesen beide denselben Stand
  // → Doppel-Einsatz bzw. Doppel-Erstattung). FOR UPDATE auf dem Preis
  // blockiert gegen gleichzeitige Ziehung (afterDraw) und Storno. Der
  // Redis-Live-Anteil kann nicht gesperrt werden — er wächst nur (Viewtime),
  // ein Doppel-Spend ist über den serialisierten Ledger ausgeschlossen.
  async placeWager(teamId, gid, username, prizeId, amount, { source = 'chat' } = {}) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [t + '|' + u]);
      const pr = await client.query(
        `SELECT id, title, status, wager_end, session_id FROM giveaway_prizes WHERE id=$1 AND team_id=$2 FOR UPDATE`, [prizeId, t]);
      if (!pr.rowCount || pr.rows[0].status !== 'open') { await client.query('ROLLBACK'); return { error: 'no_prize' }; }
      const prize = pr.rows[0];
      // Die Instanz kommt aus dem Preis selbst (mehrere Los-Giveaways je Team).
      const prizeGid = prize.session_id || gid || null;
      if (prize.wager_end && new Date(prize.wager_end).getTime() < Date.now()) {
        await client.query('ROLLBACK'); return { error: 'wager_closed' };
      }
      // Teilnahme-Gate: Guthaben sammelt jeder, aber setzen (= teilnehmen)
      // kann nur, wer das Teilnahme-Keyword der Instanz geschrieben hat.
      // Instanzen ohne Keyword (Altbestand) bleiben permissiv.
      const tbKw = prizeGid ? await this.redis.get(K.gKw(t, prizeGid)) : null;
      if (tbKw && await this.redis.get(K.gReg(t, prizeGid, u)) !== '1') {
        await client.query('ROLLBACK'); return { error: 'not_registered', keyword: tbKw };
      }

      if (amount === 0) {   // Rücknahme: kompletter Einsatz zurück (bis Einsatz-Ende)
        const st = await client.query(
          `SELECT COALESCE(SUM(amount),0) AS stake FROM prize_wagers WHERE prize_id=$1 AND username=$2`, [prizeId, u]);
        const stake = Math.round((parseFloat(st.rows[0].stake) || 0) * 10000) / 10000;
        if (stake <= 0) { await client.query('ROLLBACK'); return { error: 'nothing_to_refund' }; }
        await client.query(`INSERT INTO prize_wagers (prize_id, team_id, username, amount) VALUES ($1,$2,$3,$4)`,
          [prizeId, t, u, -stake]);
        await this.credit.book(t, u, 'refund', stake, { refPrize: prizeId, client });
        await client.query('COMMIT');
        return { refunded: stake, prizeTitle: prize.title, balance: await this.availableCredit(t, u) };
      }

      const amt = Math.floor(amount);
      if (!Number.isFinite(amt) || amt <= 0) { await client.query('ROLLBACK'); return { error: 'no_prize' }; }
      const avail = await this.credit.balance(t, u, client) + await this._liveTicketBuyCredit(t, u);
      if (avail < amt) { await client.query('ROLLBACK'); return { error: 'no_credit' }; }
      await client.query(`INSERT INTO prize_wagers (prize_id, team_id, username, amount) VALUES ($1,$2,$3,$4)`,
        [prizeId, t, u, amt]);
      await this.credit.book(t, u, 'wager', amt, { refPrize: prizeId, client });
      await client.query('COMMIT');
      await this._touchUser(t, u);
      await this.recordConsent(t, prizeGid, u, 'wager', source);   // erster Einsatz = Kenntnisnahme
      return { amount: amt, stake: await this.prizeStake(prizeId, u), prizeTitle: prize.title,
               balance: await this.availableCredit(t, u) };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* schon zu */ }
      throw e;
    } finally { client.release(); }
  }

  // Pool je Preis: Einsatzsumme je User (> 0). Gewicht = Einsatz (§5.2).
  async getPrizeStakes(teamId, prizeId) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `SELECT username, SUM(amount) AS stake FROM prize_wagers
       WHERE prize_id=$1 AND team_id=$2 GROUP BY username HAVING SUM(amount) > 0`, [prizeId, t]);
    return r.rows.map(x => ({ username: x.username, stake: Math.round(parseFloat(x.stake) * 10000) / 10000 }));
  }

  // Close einer TicketBuy-Instanz: erspielten Stand als earn ins Ledger
  // („Guthaben wandert", §10.1), danach Instanz-Keys vollständig abräumen —
  // der Zustand lebt ab jetzt ausschließlich im Journal.
  async settleTicketBuyInstance(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    const base = await this.getCoinBaseSec(t, gid);
    let channels = null;
    try { const raw = await this.redis.get(K.gChanList(t, gid)); if (raw) channels = JSON.parse(raw); } catch { /* alle */ }
    if (!Array.isArray(channels) || !channels.length) channels = await this.getChannels(t);
    let users = 0, total = 0;
    for (const u of await this.redis.smembers(K.gwUsers(t))) {
      let sec = 0;
      for (const ch of channels) sec += parseFloat(await this.redis.get(K.gWatch(t, gid, ch, u)) || '0');
      const coins = coinsFromSec(sec, base);
      if (coins <= 0) continue;
      await this.credit.book(t, u, 'earn', coins, { refSession: gid });
      users++; total += coins;
    }
    console.log(`[WTE] [${t}] ticketbuy ${gid} settled: ${users} Konten, +${total.toFixed(2)} Lose`);
    return { users, total: Math.round(total * 10000) / 10000 };
  }

  // Losanpassung (Betreiber 18.8.26): alle Lose-Konten des Teams auf null —
  // Neustart, weil Guthaben sonst über Giveaways hinweg erhalten bleibt.
  // Append-only: je Konto EINE Gegenbuchung (reset), kein DELETE. Blockiert,
  // solange irgendwo im Team ein offener Preis liegt (erst ziehen/stornieren
  // — ohne offene Preise kann parallel auch niemand setzen).
  async resetTeamCredit(teamId, { detail = null } = {}) {
    const t = sanitizeTeamId(teamId);
    const open = await this.pg.query(
      `SELECT COUNT(*)::int AS open_n FROM giveaway_prizes WHERE team_id=$1 AND status='open'`, [t]);
    const n = parseInt(open.rows[0] && open.rows[0].open_n, 10) || 0;
    if (n > 0) return { error: 'open_prizes', open: n };
    const r = await this.pg.query(
      `SELECT username, SUM(amount) AS balance FROM credit_ledger
       WHERE team_id=$1 GROUP BY username HAVING SUM(amount) > 0`, [t]);
    let users = 0, total = 0;
    for (const row of r.rows) {
      const b = Math.round((parseFloat(row.balance) || 0) * 10000) / 10000;
      if (b <= 0) continue;
      await this.credit.book(t, row.username, 'reset', b, { detail: detail || { reason: 'admin_reset' } });
      users++; total += b;
    }
    console.log(`[WTE] [${t}] Losanpassung: ${users} Konten auf 0 (-${total.toFixed(2)} Lose)`);
    return { users, total: Math.round(total * 10000) / 10000 };
  }

  // ── Phase 6: CORE_ScreenshotContest ─────────────────────
  // Berechtigung Einsenden: bestätigter Follow auf einem Instanz-Kanal UND
  // Mindest-Viewtime (Kampagnenstand des Teams). Voten: Mindest-Viewtime.
  async _contestEligibility(teamId, gid, username) {
    const t = sanitizeTeamId(teamId);
    const minWatch = parseInt(await this.redis.get(K.gMinWatch(t, gid)), 10) || 0;
    const agg = await this.getUserAggregate(t, username);   // Kampagnen-/Team-Stand
    let chans = null;
    try { const raw = await this.redis.get(K.gChanList(t, gid)); if (raw) chans = JSON.parse(raw); } catch { /* alle */ }
    if (!Array.isArray(chans) || !chans.length) chans = await this.getChannels(t);
    const followsHost = chans.some(ch => agg.perChannel[ch] && agg.perChannel[ch].follows);
    return {
      watchOk: agg.totalWatchSec >= minWatch,
      followsHost,
      minWatch,
      watchSec: agg.totalWatchSec,
    };
  }

  // Einsenden/Ersetzen. EINE Einsendung pro Person (UNIQUE); Ersetzen löscht
  // die bereits abgegebenen Stimmen für den alten Screenshot — deshalb wird
  // ohne confirmReplace abgebrochen, wenn Stimmen existieren (UI warnt).
  async submitContestEntry(teamId, gid, username, { title = '', mime, image, confirmReplace = false } = {}) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (await this.redis.get(K.gOpen(t, gid)) !== 'true') return { error: 'contest_closed' };
    if (await this.redis.get(K.gwBanned(t, u)) === '1') return { error: 'banned' };
    const elig = await this._contestEligibility(t, gid, u);
    if (!elig.followsHost) return { error: 'not_following', minWatch: elig.minWatch };
    if (!elig.watchOk)     return { error: 'not_enough_watchtime', minWatch: elig.minWatch, watchSec: elig.watchSec };

    const existing = await this.pg.query(
      `SELECT id FROM contest_entries WHERE session_id=$1 AND username=$2`, [gid, u]);
    if (existing.rowCount) {
      const votes = await this.pg.query(
        `SELECT COUNT(*)::int AS n FROM contest_votes WHERE entry_id=$1`, [existing.rows[0].id]);
      const n = votes.rows[0].n || 0;
      if (n > 0 && !confirmReplace) return { error: 'votes_would_be_lost', votes: n };
      // Neueinsendung: alte Stimmen verfallen (der bewertete Inhalt existiert
      // nicht mehr) — Warnung/Bestätigung ist oben erzwungen.
      await this.pg.query(`DELETE FROM contest_votes WHERE entry_id=$1`, [existing.rows[0].id]);
    }
    // image_token: unerratbare Bild-URL (ChatGPT-Review #8) — rotiert beim
    // Ersetzen, alte URLs werden damit ungültig.
    await this.pg.query(`
      INSERT INTO contest_entries (team_id, session_id, username, title, mime, image, status, image_token)
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
      ON CONFLICT (session_id, username) DO UPDATE SET
        title=EXCLUDED.title, mime=EXCLUDED.mime, image=EXCLUDED.image,
        image_token=EXCLUDED.image_token, status='pending', created_at=NOW()
    `, [t, gid, u, sanitizeStr(title, 100), mime, image, randomBytes(16).toString('hex')]);
    await this._touchUser(t, u);
    await this.recordConsent(t, gid, u, 'contest_entry', 'web');
    return { ok: true, replaced: existing.rowCount > 0 };
  }

  // Einsendung zurückziehen: Zeile weg = Bild weg; Stimmen fallen per
  // ON DELETE CASCADE. Nur solange die Instanz läuft (danach ist der
  // Contest entschieden und der Bestand Teil des Nachweises).
  async withdrawContestEntry(teamId, gid, username) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(username);
    if (await this.redis.get(K.gOpen(t, gid)) !== 'true') return { error: 'contest_closed' };
    const r = await this.pg.query(
      `DELETE FROM contest_entries WHERE session_id=$1 AND team_id=$2 AND username=$3 RETURNING id`,
      [gid, t, u]);
    return r.rowCount ? { ok: true, entryId: r.rows[0].id } : { error: 'no_entry' };
  }

  async reviewContestEntry(teamId, entryId, approve) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `UPDATE contest_entries SET status=$3 WHERE id=$1 AND team_id=$2 RETURNING username, title`,
      [entryId, t, approve ? 'approved' : 'rejected']);
    return r.rowCount ? { ok: true, ...r.rows[0] } : { error: 'no_entry' };
  }

  // Owner-Löschung (Moderation): Zeile weg = Bild weg, Stimmen fallen per
  // CASCADE. Anders als der Selbst-Rückzug JEDERZEIT möglich — rechtswidrige
  // Inhalte dürfen nicht bis zum Contest-Ende gespeichert bleiben. Für bloß
  // unpassende Bilder reicht reject (Anzeige gesperrt, Nachweis bleibt).
  async deleteContestEntry(teamId, entryId) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `DELETE FROM contest_entries WHERE id=$1 AND team_id=$2 RETURNING username, title`,
      [entryId, t]);
    return r.rowCount ? { ok: true, ...r.rows[0] } : { error: 'no_entry' };
  }

  // Voting-Steuerung: closed (Default) | open | paused. Nur 'open' nimmt Stimmen an.
  async setContestVoting(teamId, gid, state) {
    const t = sanitizeTeamId(teamId);
    if (!['open', 'paused', 'closed'].includes(state)) throw new Error('Ungültiger Voting-Zustand');
    await this.redis.set(K.gVoteState(t, gid), state);
    return state;
  }
  async getContestVoting(teamId, gid) {
    return await this.redis.get(K.gVoteState(sanitizeTeamId(teamId), gid)) || 'closed';
  }

  // Eine Stimme je (Voter, Screenshot); erneutes Voten überschreibt (UPSERT).
  // Eigene Einsendung ist nicht votebar.
  async castContestVote(teamId, gid, voter, entryId, score) {
    const t = sanitizeTeamId(teamId), u = sanitizeUsername(voter);
    if (await this.getContestVoting(t, gid) !== 'open') return { error: 'voting_not_open' };
    if (await this.redis.get(K.gwBanned(t, u)) === '1') return { error: 'banned' };
    const elig = await this._contestEligibility(t, gid, u);
    if (!elig.watchOk) return { error: 'not_enough_watchtime', minWatch: elig.minWatch, watchSec: elig.watchSec };
    const entry = await this.pg.query(
      `SELECT id, username, status FROM contest_entries WHERE id=$1 AND session_id=$2 AND team_id=$3`,
      [entryId, gid, t]);
    if (!entry.rowCount || entry.rows[0].status !== 'approved') return { error: 'no_entry' };
    if (entry.rows[0].username === u) return { error: 'own_entry' };
    await this.pg.query(`
      INSERT INTO contest_votes (entry_id, team_id, session_id, voter, score)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (entry_id, voter) DO UPDATE SET score=EXCLUDED.score, created_at=NOW()
    `, [entryId, t, gid, u, score]);
    await this.recordConsent(t, gid, u, 'contest_vote', 'web');
    return { ok: true, score };
  }

  // Ranking: Punktsumme + Stimmenzahl je Einsendung (approved für die Ziehung;
  // all=true liefert auch pending/rejected fürs Admin-Review).
  async getContestStandings(teamId, gid, { all = false } = {}) {
    const t = sanitizeTeamId(teamId);
    const r = await this.pg.query(
      `SELECT e.id AS entry_id, e.username, e.title, e.status, e.image_token,
              COALESCE(SUM(v.score),0)::int AS score, COUNT(v.id)::int AS votes
       FROM contest_entries e
       LEFT JOIN contest_votes v ON v.entry_id = e.id
       WHERE e.session_id=$1 AND e.team_id=$2` + (all ? '' : ` AND e.status='approved'`) +
      ` GROUP BY e.id, e.username, e.title, e.status, e.image_token
       ORDER BY score DESC, votes DESC, e.id`, [gid, t]);
    return r.rows.map(x => ({ entryId: parseInt(x.entry_id), username: x.username, title: x.title || '',
                              status: x.status, score: x.score, votes: x.votes,
                              imageToken: x.image_token || null }));
  }

  // Räumt eine (gezogene/geschlossene) Instanz vollständig aus Redis —
  // keine g:-Leichen (§6). Nach der Auto-Ziehung der Sofortverlosung
  // aufgerufen; für manuell geschlossene Instanzen erst nach der Ziehung.
  async cleanupGiveawayInstance(teamId, gid) {
    const t = sanitizeTeamId(teamId);
    const channels = await this.getChannels(t);
    const users = await this.redis.smembers(K.gwUsers(t));
    const pipeline = this.redis.pipeline();
    for (const u of users) {
      pipeline.del(K.gReg(t, gid, u));
      for (const ch of channels) {
        pipeline.del(K.gWatch(t, gid, ch, u), K.gChatTs(t, gid, ch, u), K.gMsgs(t, gid, ch, u));
      }
    }
    pipeline.del(K.gOpen(t, gid), K.gPaused(t, gid), K.gKw(t, gid), K.gChanList(t, gid),
                 K.gCore(t, gid), K.gWinEnd(t, gid), K.gMult(t, gid), K.gWagerCmd(t, gid),
                 K.gMinWatch(t, gid), K.gVoteState(t, gid), K.gAnnounce(t, gid), K.gName(t, gid),
                 K.gCfgFollowMin(t, gid), K.gCfgCoinBase(t, gid),
                 K.gCfgChatBonus(t, gid), K.gCfgChatWords(t, gid), K.gCfgChatCool(t, gid));
    pipeline.srem(K.gwSet(t), gid);
    await pipeline.exec();
    console.log(`[WTE] [${t}] instance ${gid} cleaned`);
  }

  async drawWinner(teamId, sessionId, opts = {}) {
    const t = sanitizeTeamId(teamId);
    const isTest = !!opts.test;
    const prize  = opts.prize ? sanitizeStr(opts.prize, 100) : null;
    // Pool-Bildung (Filter + Gewicht) macht der Core; Zufall, Snapshot und
    // Persistenz bleiben hier — genau EINE Stelle, die reproduzierbar zieht.
    // Gezogen wird der Stand DIESES Giveaways (sessionId = Giveaway-ID) mit
    // DESSEN Core (Phase 3: Sofortverlosung hat weder Coins noch Follows).
    const drawCoreId = await this.getCoreId(t, sessionId);
    const drawCore = getCore(drawCoreId);
    let poolSource, drawPrizeId = null;
    if (drawCoreId === 'CORE_TicketBuy') {
      // TicketBuy zieht JE PREIS: Gewicht = gesetzte Lose (§5.2).
      drawPrizeId = parseInt(opts.prizeId, 10);
      if (!Number.isFinite(drawPrizeId) || drawPrizeId <= 0) {
        throw new Error('CORE_TicketBuy zieht je Preis — prizeId fehlt');
      }
      // Der Preis muss zu DIESEM Giveaway gehoeren — seit mehrere
      // Los-Giveaways parallel laufen duerfen, waere sonst ein Ziehungssatz
      // mit fremder Session moeglich.
      if (await this.prizeGiveawayId(t, drawPrizeId) !== sessionId) {
        throw new Error('prize_not_in_giveaway');
      }
      poolSource = await this.getPrizeStakes(t, drawPrizeId);
    } else if (drawCoreId === 'CORE_ScreenshotContest') {
      // Deterministisch: buildPool liefert nur die Führenden (weight 1);
      // bei Punktgleichstand lost der normale Engine-Zufall aus. Voting zu.
      await this.setContestVoting(t, sessionId, 'closed');
      poolSource = await this.getContestStandings(t, sessionId);
    } else if (drawCore.accrual === 'none') {
      poolSource = await this.getInstantParticipants(t, sessionId);
    } else {
      poolSource = await this.getAllParticipants(t, sessionId || undefined);
    }
    let pool = drawCore.buildPool(poolSource);
    // P6: Ersatzziehung — der ursprüngliche Gewinner wird ausgeschlossen.
    if (opts.excludeWinner) pool = pool.filter(e => e.username !== opts.excludeWinner);
    if (!pool.length) return null;
    const eligible = pool.map(e => e.meta);

    const total = pool.reduce((s, e) => s + e.weight, 0);
    const rand  = (randomInt(0, 2 ** 31) / (2 ** 31)) * total;
    let acc = 0, winner = eligible[eligible.length - 1];
    for (const e of pool) { acc += e.weight; if (rand < acc) { winner = e.meta; break; } }

    const snapshot = eligible.map(p => ({
      u: p.username, c: p.totalCoins, q: p.channelsQualified,
      ch: Object.fromEntries(Object.entries(p.perChannel).map(([k, v]) => [k, v.coins])),
      f: (p.flags || []).map(x => x.reason),   // Anti-Abuse-Flags zum Ziehungszeitpunkt
    }));
    const totalRounded = Math.round(total * 10000) / 10000;
    const randRounded  = Math.round(rand * 1e10) / 1e10;

    const client = await this.pg.connect();
    let drawId = null, drawIndex = 1;
    try {
      await client.query('BEGIN');
      // TicketBuy: Preis-Zeile SOFORT sperren und Einsatzsumme gegen den
      // Pool prüfen — eine Rücknahme zwischen Pool-Aufbau und Ziehung würde
      // sonst mit bereits erstattetem Einsatz gewinnen (ChatGPT-Review #1).
      if (drawPrizeId && !isTest) {
        const chk = await client.query(
          `SELECT id, status FROM giveaway_prizes WHERE id=$1 AND team_id=$2 FOR UPDATE`, [drawPrizeId, t]);
        if (!chk.rowCount || chk.rows[0].status !== 'open') throw new Error('prize_not_open');
        const sum = await client.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM prize_wagers WHERE prize_id=$1`, [drawPrizeId]);
        const cur = Math.round((parseFloat(sum.rows[0].total) || 0) * 10000) / 10000;
        if (Math.abs(cur - totalRounded) > 1e-6) throw new Error('stakes_changed_retry');
      }
      const idxRes = await client.query(
        sessionId ? `SELECT COUNT(*)::int AS n FROM giveaway_draws WHERE session_id=$1`
                  : `SELECT COUNT(*)::int AS n FROM giveaway_draws WHERE session_id IS NULL AND drawn_at > NOW() - INTERVAL '1 day'`,
        sessionId ? [sessionId] : []);
      drawIndex = (idxRes.rows[0]?.n || 0) + 1;
      const ins = await client.query(`
        INSERT INTO giveaway_draws
          (session_id, winner, winner_coins, winner_watch_sec, total_coins,
           eligible_count, rand_value, draw_index, is_test, prize, eligible_snapshot, core, prize_id,
           reroll_of, reroll_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id
      `, [sessionId || null, winner.username, winner.totalCoins, Math.round(winner.totalWatchSec || 0),
          totalRounded, eligible.length, randRounded, drawIndex, isTest, prize, JSON.stringify(snapshot),
          drawCoreId, drawPrizeId,   // Mechanik + Preis — Nachvollziehbarkeit (§7)
          opts.rerollOf || null, opts.rerollReason || null]);
      drawId = ins.rows[0].id;
      if (!isTest) {
        let prevWinner = null;
        if (sessionId) prevWinner = (await client.query(`SELECT winner FROM sessions WHERE id=$1`, [sessionId])).rows[0]?.winner || null;
        if (prevWinner !== winner.username) {
          if (prevWinner) await client.query(`UPDATE users SET times_won = GREATEST(times_won-1,0) WHERE username=$1`, [prevWinner]);
          await client.query(`INSERT INTO users (username, display, times_won, last_seen) VALUES ($1,$2,1,NOW())
                              ON CONFLICT (username) DO UPDATE SET times_won = users.times_won+1, last_seen=NOW()`,
                              [winner.username, winner.username]);
        }
        if (sessionId) await client.query(`UPDATE sessions SET winner=$1, winner_watch_sec=$2, winner_coins=$3 WHERE id=$4`,
                                           [winner.username, Math.round(winner.totalWatchSec || 0), winner.totalCoins, sessionId]);
        // afterDraw (§5.2, in DERSELBEN Transaktion): der Preis ist gezogen,
        // damit sind die Einsätze ALLER Setzer gebunden — keine Rücknahme
        // mehr möglich (placeWager prüft status='open').
        if (drawPrizeId) await client.query(`UPDATE giveaway_prizes SET status='drawn' WHERE id=$1`, [drawPrizeId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); console.error('[WTE] drawWinner error:', e.message); throw e;
    } finally { client.release(); }

    console.log(`[WTE] [${t}] Draw #${drawId}: ${winner.username} won, coins=${winner.totalCoins}, eligible=${eligible.length}, test=${isTest}`);
    return { winner: winner.username, coins: winner.totalCoins, watchSec: Math.round(winner.totalWatchSec || 0),
             drawId, drawIndex, sessionId, eligibleCount: eligible.length,
             total: totalRounded, rand: randRounded, isTest, prize, prizeId: drawPrizeId,
             // P4: Semantik für die Anzeige — core sagt, was `coins` bedeutet
             // (Punkte/Einsatz/Score); msgs trägt beim Contest die Stimmenzahl.
             core: drawCoreId, msgs: winner.msgs || 0 };
  }

  async closeGiveaway(teamId, sessionId) {
    const t = sanitizeTeamId(teamId);
    await this.redis.set(K.gwOpen(t), 'false');
    if (sessionId) {
      await this.redis.set(K.gOpen(t, sessionId), 'false');
      await this.redis.srem(K.gwSet(t), sessionId);
    }
    // Team bleibt im Scan-Set, solange noch eine Sekundär-Instanz läuft.
    if (!(await this._activeGiveaways(t)).length) await this.redis.srem(K.openTeams(), t);
    if (!sessionId) return;
    const participants = await this.getAllParticipants(t, sessionId);
    const active = participants.filter(p => !p.banned);
    const totalCoins = active.reduce((s, p) => s + p.totalCoins, 0);
    const channels = await this.getChannels(t);

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      for (const p of participants) {
        for (const ch of channels) {
          const pc = p.perChannel[ch] || { watchSec: 0, msgs: 0, coins: 0, follows: false };
          if (pc.watchSec <= 0 && pc.msgs <= 0) continue;
          await client.query(`
            INSERT INTO campaign_participation (session_id, username, channel, watch_sec, msgs, coins, follows, valid)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (session_id, username, channel) DO UPDATE SET
              watch_sec=EXCLUDED.watch_sec, msgs=EXCLUDED.msgs, coins=EXCLUDED.coins,
              follows=EXCLUDED.follows, valid=EXCLUDED.valid
          `, [sessionId, p.username, ch, Math.round(pc.watchSec), pc.msgs, pc.coins, pc.follows, pc.follows && pc.coins > 0]);
        }
      }
      const upd = await client.query(`
        UPDATE sessions SET total_participants=$1, total_coins=$2, channels=$3, closed_at=NOW()
        WHERE id=$4 AND closed_at IS NULL
      `, [active.length, Math.round(totalCoins * 10000) / 10000, JSON.stringify(channels), sessionId]);
      // Kampagnen-Klammer sauber abschließen: Auto-Open hat je Stream-Start
      // eine neue Sitzung angelegt und die alte offen liegen lassen — beim
      // Beenden der Kampagne werden diese Vorgänger mitgeschlossen
      // (closed_at = letztes eigenes Event, sonst opened_at).
      const orphans = await client.query(`
        UPDATE sessions s SET status='closed',
          closed_at = COALESCE((SELECT MAX(ts) FROM watchtime_events w WHERE w.session_id = s.id), s.opened_at)
        WHERE s.team_id=$1 AND s.closed_at IS NULL AND s.id <> $2
          AND (s.core IS NULL OR s.core='CORE_WatchtimeChatActivity')
          AND s.opened_at < (SELECT opened_at FROM sessions WHERE id=$2)
      `, [t, sessionId]);
      if (orphans.rowCount) console.log(`[WTE] [${t}] ${orphans.rowCount} verwaiste Vorgänger-Sitzungen mitgeschlossen`);
      if (upd.rowCount > 0) {
        for (const p of participants) {
          await client.query(`INSERT INTO users (username, display, total_watch_sec, last_seen) VALUES ($1,$1,$2,NOW())
                              ON CONFLICT (username) DO UPDATE SET total_watch_sec = users.total_watch_sec+$2, last_seen=NOW()`,
                              [p.username, Math.round(p.totalWatchSec)]);
        }
      }
      await client.query('COMMIT');
      console.log(`[WTE] [${t}] session ${sessionId} closed, ${participants.length} participants`);
    } catch(e) { await client.query('ROLLBACK'); console.error('[WTE] closeGiveaway error:', e.message); }
    finally { client.release(); }
  }

  async resetGiveaway(teamId) {
    const t = sanitizeTeamId(teamId);
    const channels = await this.getChannels(t);
    const users = await this.redis.smembers(K.gwUsers(t));
    const gid = await this.redis.get(K.gwSessionId(t));   // vor dem Löschen merken
    const pipeline = this.redis.pipeline();
    for (const u of users) {
      pipeline.del(K.gwRegistered(t, u));
      if (gid) pipeline.del(K.gReg(t, gid, u));
      pipeline.del(K.gwBanned(t, u));
      pipeline.srem(K.userTeams(u), t);
      pipeline.del(K.abuseHist(t, u), K.abuseTimes(t, u));
      for (const ch of channels) {
        pipeline.del(K.chWatch(t, ch, u), K.chChatTs(t, ch, u), K.chPresent(t, ch, u),
                     K.chLastTick(t, ch, u), K.chMsgs(t, ch, u), K.chFollows(t, ch, u));
        // g:-Namespace vollständig mitwegräumen — keine Redis-Leichen (§6).
        if (gid) pipeline.del(K.gWatch(t, gid, ch, u), K.gChatTs(t, gid, ch, u), K.gMsgs(t, gid, ch, u));
      }
    }
    for (const ch of channels) pipeline.del(K.chIndex(t, ch));
    pipeline.del(K.gwUsers(t));
    pipeline.set(K.gwOpen(t), 'false');
    pipeline.del(K.gwPaused(t));
    pipeline.srem(K.openTeams(), t);
    pipeline.del(K.gwKeyword(t));
    pipeline.del(K.gwSessionId(t));
    pipeline.del(K.gwMult(t));
    if (gid) pipeline.del(K.gMult(t, gid), K.gCfgFollowMin(t, gid), K.gCfgCoinBase(t, gid),
                          K.gCfgChatBonus(t, gid), K.gCfgChatWords(t, gid), K.gCfgChatCool(t, gid));
    pipeline.del(K.gwChannels(t));
    await pipeline.exec();
    console.log(`[WTE] [${t}] reset`);
  }

  // ── Backup: Export / Import ─────────────────────────────
  // Der Live-Stand liegt in Redis und ist damit das, was bei einem Volume-Verlust
  // weg wäre (PG-Historie deckt der Backup-Container ab). Export liefert genau so
  // viel, dass importTeam() den Stand vollständig wiederherstellen kann.
  async exportTeam(teamId) {
    const t = sanitizeTeamId(teamId);
    if (!t) throw new Error('Invalid teamId');
    const channels = await this.getChannels(t);
    const users = await this.redis.smembers(K.gwUsers(t));
    const gid = await this._gid(t);

    const participants = [];
    for (const u of users) {
      const perChannel = {};
      for (const ch of channels) {
        const watchSec = parseFloat((gid ? await this._readMech(K.gWatch(t, gid, ch, u), K.chWatch(t, ch, u))
                                         : await this.redis.get(K.chWatch(t, ch, u))) || '0');
        const msgs     = parseInt((gid ? await this._readMech(K.gMsgs(t, gid, ch, u), K.chMsgs(t, ch, u))
                                       : await this.redis.get(K.chMsgs(t, ch, u))) || '0');
        const follows  = await this.redis.get(K.chFollows(t, ch, u));
        if (!watchSec && !msgs && follows === null) continue;   // nie aktiv gewesen
        perChannel[ch] = { watchSec, msgs, follows };
      }
      participants.push({
        username: u,
        registered: (gid ? await this._readMech(K.gReg(t, gid, u), K.gwRegistered(t, u))
                         : await this.redis.get(K.gwRegistered(t, u))) === '1',
        banned:     await this.redis.get(K.gwBanned(t, u)) === '1',
        perChannel,
      });
    }

    return {
      format: 'cc-giveaway-backup',
      version: 1,
      teamId: t,
      channels,
      config: {
        keyword:      await this.redis.get(K.gwKeyword(t)) || '',
        followMin:    await this.getFollowMin(t),
        coinBaseSec:  await this.getCoinBaseSec(t),
        chat:         await this.getChatConfig(t),
        autoPause:    await this.redis.get(K.cfgAutoPause(t)) === '1',
        autoResume:   await this.redis.get(K.cfgAutoResume(t)) === '1',
      },
      state: {
        open:      await this.redis.get(K.gwOpen(t)) === 'true',
        paused:    await this.redis.get(K.gwPaused(t)) === 'true',
        sessionId: await this.redis.get(K.gwSessionId(t)) || null,
      },
      participants,
    };
  }

  // mode 'replace' = Stand exakt wiederherstellen (vorher alles löschen).
  // mode 'merge'   = importierte Viewtime/Msgs auf den vorhandenen Stand addieren.
  // Multiplier wird bewusst NICHT importiert: ein zeitlich begrenzter Boost aus
  // einem alten Backup würde beim Restore fälschlich weiterlaufen.
  async importTeam(teamId, data, opts = {}) {
    const t = sanitizeTeamId(teamId);
    if (!t) throw new Error('Invalid teamId');
    if (!data || data.format !== 'cc-giveaway-backup') throw new Error('Kein gültiges Backup (format)');
    if (Number(data.version) !== 1) throw new Error(`Backup-Version ${data.version} wird nicht unterstützt`);
    if (!Array.isArray(data.participants)) throw new Error('Backup enthält keine participants');

    const mode = opts.mode === 'merge' ? 'merge' : 'replace';
    if (mode === 'replace') await this.resetGiveaway(t);

    const cfg = data.config || {};
    if (typeof cfg.keyword === 'string')       await this.redis.set(K.gwKeyword(t), sanitizeStr(cfg.keyword, 100));
    if (Number.isFinite(Number(cfg.followMin)))   await this.setFollowMin(t, cfg.followMin);
    if (Number.isFinite(Number(cfg.coinBaseSec))) await this.setCoinBaseSec(t, cfg.coinBaseSec);
    if (cfg.chat) await this.setChatConfig(t, cfg.chat);
    if (cfg.autoPause)  await this.redis.set(K.cfgAutoPause(t), '1');
    if (cfg.autoResume) await this.redis.set(K.cfgAutoResume(t), '1');

    // Beim Merge in ein laufendes Giveaway muss auf dessen g:-Keys gebucht
    // werden — sonst forken Import und Live-Stand. Nach replace ist gid null
    // (Reset), geschrieben wird Legacy; der Fallback liest das korrekt.
    const gid = await this._gid(t);
    let users = 0, channelsTouched = new Set();
    for (const p of data.participants) {
      const u = sanitizeUsername(p && p.username);
      if (!u) continue;
      users++;
      await this._touchUser(t, u);
      if (p.registered) await this.redis.set(gid ? K.gReg(t, gid, u) : K.gwRegistered(t, u), '1');
      if (p.banned)     await this.redis.set(K.gwBanned(t, u), '1');
      for (const [rawCh, v] of Object.entries(p.perChannel || {})) {
        const ch = sanitizeChannel(rawCh);
        if (!ch || !v) continue;
        channelsTouched.add(ch);
        await this.redis.sadd(K.chIndex(t, ch), u);
        const watchSec = Math.max(0, parseFloat(v.watchSec) || 0);
        const msgs     = Math.max(0, parseInt(v.msgs) || 0);
        const wKey = gid ? K.gWatch(t, gid, ch, u) : K.chWatch(t, ch, u);
        const mKey = gid ? K.gMsgs(t, gid, ch, u)  : K.chMsgs(t, ch, u);
        if (gid) { await this._migrateKey(wKey, K.chWatch(t, ch, u)); await this._migrateKey(mKey, K.chMsgs(t, ch, u)); }
        if (mode === 'merge') {
          if (watchSec) await this.redis.incrbyfloat(wKey, watchSec);
          if (msgs)     await this.redis.incrby(mKey, msgs);
        } else {
          await this.redis.set(wKey, String(watchSec));
          await this.redis.set(mKey, String(msgs));
        }
        // follows: null bedeutet "nie gesehen" und bleibt null (permissiv),
        // '0'/'1' sind bestätigte Zustände und werden übernommen.
        if (v.follows === '1' || v.follows === true)  await this.redis.set(K.chFollows(t, ch, u), '1');
        else if (v.follows === '0' || v.follows === false) await this.redis.set(K.chFollows(t, ch, u), '0');
      }
    }

    // Session/Offen-Status nur bei replace übernehmen — beim Merge läuft ja eine.
    if (mode === 'replace' && data.state) {
      if (data.state.sessionId && /^sess_\d+$/i.test(data.state.sessionId)) {
        await this.redis.set(K.gwSessionId(t), data.state.sessionId);
      }
      if (data.state.open) {
        await this.redis.set(K.gwOpen(t), 'true');
        await this.redis.sadd(K.openTeams(), t);
        if (data.state.paused) await this.redis.set(K.gwPaused(t), 'true');
      }
    }
    console.log(`[WTE] [${t}] import mode=${mode} users=${users}`);
    return { mode, users, channels: [...channelsTouched] };
  }
}

module.exports = {
  WatchtimeEngine, K, sanitizeUsername, sanitizeChannel, sanitizeStr, sanitizeTeamId, countWords, coinsFromSec, matchesKeyword,
  SECS_PER_COIN, CHAT_BONUS_SEC, CHAT_COOLDOWN, CHAT_MIN_WORDS, TICK_SEC, PRESENCE_TTL,
  JOIN_MIN_COINS, MIN_CHANNELS, ABUSE,
};
