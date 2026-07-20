'use strict';

// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Watchtime / Ticket Engine (multi-tenant)
// Alles pro (team, user, channel). Redis-Keys mit t:{teamId}: Prefix.
// Kanäle eines Teams = dessen team_members (PG, kurz gecacht).
// 7200s = 1 Ticket. Chat (>3 Wörter) = +0.5s. Viewtime-Multiplier
// (time-boxed) gilt Tick+Chat. Opt-in via Keyword ab ≥1 Coin.
// Eligibility: valide Coins auf ≥2 Kanälen. Gewicht = Summe Coins.
// ════════════════════════════════════════════════════════

const { randomInt, createHash } = require('crypto');

// ── Anti-Abuse: deterministische, reproduzierbare Schwellen ──
const ABUSE = {
  HIST_LEN: 20, TIMES_LEN: 30,
  DUP_MIN: 3,               // identische Nachricht ≥3× im Fenster → dup_message
  RATE_WINDOW: 60, RATE_MAX: 10,   // >10 Nachrichten / 60s → high_rate
  DIV_MIN_MSGS: 10, DIV_RATIO: 0.4, // ≥10 Nachrichten, <40% verschieden → low_diversity
  NEW_ACCOUNT_DAYS: 30,     // Twitch-Account jünger als 30 Tage → new_account
};

const SECS_PER_COIN  = 7200;
const CHAT_BONUS_SEC = 2;    // sinnvolle Chatnachricht (>3 Wörter) = +2s Viewtime
const CHAT_COOLDOWN  = 10;
const CHAT_MIN_WORDS = 4;    // >3 Wörter
const TICK_SEC       = 60;
const PRESENCE_TTL   = 600;
const JOIN_MIN_COINS = 1;
const MIN_CHANNELS   = 2;
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

function countWords(msg) {
  let count = 0, inWord = false;
  for (const ch of msg) {
    if (ch === ' ' || ch === '\t') { inWord = false; }
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// Coin-Basis ist per-Team konfigurierbar (getCoinBaseSec). SECS_PER_COIN = Default.
function coinsFromSec(watchSec, baseSec) {
  const base = (Number.isFinite(baseSec) && baseSec > 0) ? baseSec : SECS_PER_COIN;
  return Math.round((watchSec / base) * 10000) / 10000;
}

function sanitizeTeamId(t) {
  return String(t || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
}

class WatchtimeEngine {
  constructor(redis, pg) {
    this.redis = redis;
    this.pg    = pg;
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

  // ── Multiplier ──────────────────────────────────────────
  async getMultiplier(teamId) {
    const f = parseFloat(await this.redis.get(K.gwMult(sanitizeTeamId(teamId))) || '1');
    return (isFinite(f) && f > 0) ? f : 1;
  }
  // Teilnahmebedingung: wie vielen Kanälen muss man folgen (per-Team, default MIN_CHANNELS).
  async getFollowMin(teamId) {
    const v = parseInt(await this.redis.get(K.cfgFollowMin(sanitizeTeamId(teamId))), 10);
    return (Number.isFinite(v) && v >= 0) ? v : MIN_CHANNELS;
  }
  async setFollowMin(teamId, n) {
    const t = sanitizeTeamId(teamId);
    const v = Math.max(0, Math.min(10, parseInt(n, 10) || 0));
    await this.redis.set(K.cfgFollowMin(t), String(v));
    return v;
  }
  // Coin-Basis (Sek.) = EIN Wert für zwei Dinge (per-Team):
  //   1 Coin  = coinBaseSec Viewtime
  //   Lostopf = ab 1 Coin, also ebenfalls coinBaseSec Viewtime
  // Redis-Key bleibt cfgDrawMinSec (Abwärtskompatibilität bestehender Configs).
  async getCoinBaseSec(teamId) {
    const v = parseInt(await this.redis.get(K.cfgDrawMinSec(sanitizeTeamId(teamId))), 10);
    return (Number.isFinite(v) && v >= 60) ? v : SECS_PER_COIN;   // 7200 = 2h
  }
  async setCoinBaseSec(teamId, sec) {
    const t = sanitizeTeamId(teamId);
    const v = Math.max(60, Math.min(360000, Math.round(parseFloat(sec) || 0)));  // 1min..100h
    await this.redis.set(K.cfgDrawMinSec(t), String(v));
    return v;
  }
  // Alias: Schwelle für den Lostopf == Coin-Basis (1 Coin).
  async getDrawMinSec(teamId) { return this.getCoinBaseSec(teamId); }
  async setDrawMinSec(teamId, sec) { return this.setCoinBaseSec(teamId, sec); }

  // Chat-Bonus (per-Team). Defaults = die bisherigen Konstanten.
  async getChatConfig(teamId) {
    const t = sanitizeTeamId(teamId);
    const num = async (key, def, min, max) => {
      const v = parseFloat(await this.redis.get(key(t)));
      return (Number.isFinite(v) && v >= min && v <= max) ? v : def;
    };
    return {
      bonusSec: await num(K.cfgChatBonus, CHAT_BONUS_SEC, 0, 300),
      minWords: await num(K.cfgChatWords, CHAT_MIN_WORDS, 1, 50),
      cooldown: await num(K.cfgChatCool,  CHAT_COOLDOWN,  0, 3600),
    };
  }
  async setChatConfig(teamId, cfg = {}) {
    const t = sanitizeTeamId(teamId);
    const put = async (key, val, min, max, round) => {
      if (val === undefined || val === null || val === '') return;
      let v = parseFloat(val);
      if (!Number.isFinite(v)) return;
      v = Math.max(min, Math.min(max, round ? Math.round(v) : v));
      await this.redis.set(key(t), String(v));
    };
    await put(K.cfgChatBonus, cfg.bonusSec, 0, 300, false);
    await put(K.cfgChatWords, cfg.minWords, 1, 50, true);
    await put(K.cfgChatCool,  cfg.cooldown, 0, 3600, true);
    return this.getChatConfig(t);
  }
  async setMultiplier(teamId, factor, seconds) {
    const t = sanitizeTeamId(teamId);
    const f = Math.max(1, Math.min(10, parseFloat(factor) || 1));
    const s = Math.max(1, Math.min(86400, parseInt(seconds) || 0));
    if (f <= 1 || !s) { await this.redis.del(K.gwMult(t)); return { factor: 1, seconds: 0 }; }
    await this.redis.set(K.gwMult(t), String(f), 'EX', s);
    return { factor: f, seconds: s };
  }
  async multiplierState(teamId) {
    const t = sanitizeTeamId(teamId);
    const f = await this.getMultiplier(t);
    const ttl = f > 1 ? await this.redis.ttl(K.gwMult(t)) : 0;
    return { factor: f, secondsLeft: ttl > 0 ? ttl : 0 };
  }

  _followAllowed(val) { return val !== '0'; }

  async isOpen(teamId)      { return await this.redis.get(K.gwOpen(sanitizeTeamId(teamId))) === 'true'; }
  async isPaused(teamId)    { return await this.redis.get(K.gwPaused(sanitizeTeamId(teamId))) === 'true'; }
  // Aktiv = offen UND nicht pausiert → nur dann läuft Accrual.
  async isActive(teamId)    { const t = sanitizeTeamId(teamId);
    return await this.redis.get(K.gwOpen(t)) === 'true' && await this.redis.get(K.gwPaused(t)) !== 'true'; }
  async setPaused(teamId, paused) {
    const t = sanitizeTeamId(teamId);
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
      if (await this.redis.get(K.gwOpen(t)) !== 'true') { await this.redis.srem(K.openTeams(), t); continue; }
      if (await this.redis.get(K.gwPaused(t)) === 'true') continue;   // pausiert: kein Accrual, bleibt offen
      const sid = await this.redis.get(K.gwSessionId(t));
      const channels = await this.getChannels(t);
      const mult = await this.getMultiplier(t);
      const base = await this.getCoinBaseSec(t);
      const inc  = TICK_SEC * mult;
      for (const ch of channels) {
        const users = await this.redis.smembers(K.chIndex(t, ch));
        for (const u of users) {
          if (await this.redis.get(K.gwBanned(t, u)) === '1') continue;
          if (!await this.redis.get(K.chPresent(t, ch, u))) continue;
          if (!this._followAllowed(await this.redis.get(K.chFollows(t, ch, u)))) continue;
          const newSec = parseFloat(await this.redis.incrbyfloat(K.chWatch(t, ch, u), inc));
          await this._logEvent(t, u, 'tick', inc, sid, ch);
          updates.push({ teamId: t, username: u, channel: ch, watchSec: newSec, coins: coinsFromSec(newSec, base) });
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
    // Nur bei aktivem (offen + nicht pausiert) Giveaway zählt Chat.
    if (await this.redis.get(K.gwOpen(t)) !== 'true' || await this.redis.get(K.gwPaused(t)) === 'true') return null;

    const ch = await this.resolveChannel(t, channel);
    if (!ch) return null;
    const cleanMsg = sanitizeStr(message, 500).trim();
    const sid = await this.redis.get(K.gwSessionId(t));

    await this.redis.set(K.chPresent(t, ch, u), '1', 'EX', PRESENCE_TTL);
    if (follows !== undefined) await this.redis.set(K.chFollows(t, ch, u), follows ? '1' : '0');
    await this._touchUser(t, u);
    await this.redis.sadd(K.chIndex(t, ch), u);

    const keyword = await this.redis.get(K.gwKeyword(t));
    if (matchesKeyword(cleanMsg, keyword)) {
      await this.redis.incr(K.chMsgs(t, ch, u));
      return this._tryRegister(t, u, username);
    }

    if (await this.redis.get(K.gwBanned(t, u)) === '1') return null;
    await this.redis.incr(K.chMsgs(t, ch, u));
    await this._detectAbuse(t, u, cleanMsg);   // Spam-Signale (flaggt, bannt nicht)

    if (!this._followAllowed(await this.redis.get(K.chFollows(t, ch, u)))) return { channel: ch, followed: false };

    const chatCfg = await this.getChatConfig(t);
    if (!chatCfg.bonusSec) return null;                      // Bonus abgeschaltet
    if (countWords(cleanMsg) < chatCfg.minWords) return null;

    const chatKey = K.chChatTs(t, ch, u);
    const now = Math.floor(Date.now() / 1000);
    const lastTs = await this.redis.get(chatKey);
    if (lastTs && (now - parseInt(lastTs)) < chatCfg.cooldown) return null;

    const mult = await this.getMultiplier(t);
    const inc  = chatCfg.bonusSec * mult;
    await this.redis.set(chatKey, String(now), 'EX', 86400);
    const newSec = parseFloat(await this.redis.incrbyfloat(K.chWatch(t, ch, u), inc));
    await this._logEvent(t, u, 'chat_bonus', inc, sid, ch);

    return { added: inc, channel: ch, watchSec: newSec, coins: coinsFromSec(newSec, await this.getCoinBaseSec(t)) };
  }

  async _tryRegister(teamId, username, displayName) {
    // Opt-in per Keyword: JEDER kann sich anmelden (= Zustimmung Regeln).
    // Für den Lostopf zählt separat die Berechtigung (Follows + ≥2h Viewtime),
    // siehe getUserAggregate.eligible.
    const already = await this.redis.get(K.gwRegistered(teamId, username));
    await this.redis.set(K.gwRegistered(teamId, username), '1');
    await this._touchUser(teamId, username);
    await this.pg.query(`
      INSERT INTO users (username, display) VALUES ($1, $2)
      ON CONFLICT (username) DO UPDATE SET display = EXCLUDED.display, last_seen = NOW()
    `, [username, sanitizeStr(displayName, 50) || username]);
    const agg = await this.getUserAggregate(teamId, username);
    return { ...agg, registered: true, isNew: !already };
  }

  async registerUser(teamId, username) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    if (!t || !u) return null;
    await this.redis.set(K.gwRegistered(t, u), '1');
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
    let after = parseFloat(await this.redis.incrbyfloat(K.chWatch(t, ch, u), deltaSec));
    if (after < 0) { await this.redis.set(K.chWatch(t, ch, u), '0'); after = 0; }
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
  async getUserAggregate(teamId, username) {
    const t = sanitizeTeamId(teamId);
    const u = sanitizeUsername(username);
    const channels = await this.getChannels(t);
    const base = await this.getCoinBaseSec(t);
    const perChannel = {};
    let totalWatch = 0, totalMsgs = 0, followed = 0;
    for (const ch of channels) {
      const watchSec = parseFloat(await this.redis.get(K.chWatch(t, ch, u)) || '0');
      const msgs     = parseInt(await this.redis.get(K.chMsgs(t, ch, u)) || '0');
      // Follow-Gate STRIKT: nur bestätigte Follows (Live-Event '1' oder Helix) zählen.
      // (Viewtime-Accrual bleibt permissiv, siehe tickPresentUsers.)
      const follows  = (await this.redis.get(K.chFollows(t, ch, u))) === '1';
      const coins    = coinsFromSec(watchSec, base);
      perChannel[ch] = { watchSec, coins, msgs, follows };
      totalWatch += watchSec; totalMsgs += msgs;
      if (follows) followed++;   // Follow zählt UNABHÄNGIG vom Gucken
    }
    const totalCoins = coinsFromSec(totalWatch, base);
    const followMin  = await this.getFollowMin(t);
    const drawMinSec = base;   // Lostopf-Schwelle == 1 Coin == Coin-Basis
    const registered = await this.redis.get(K.gwRegistered(t, u)) === '1';
    const banned     = await this.redis.get(K.gwBanned(t, u)) === '1';
    // Lostopf: Keyword + folgt ≥followMin Kanälen + ≥1 Coin (irgendwo geguckt).
    const eligible   = registered && !banned && followed >= followMin && totalCoins >= 1;
    return {
      username: u, perChannel, totalWatchSec: totalWatch, totalCoins,
      channelsQualified: followed, channelsFollowed: followed, followMin, drawMinSec, coinBaseSec: base,
      registered, banned, eligible,
      coins: totalCoins, watchSec: totalWatch, msgs: totalMsgs,
    };
  }
  async getUserState(teamId, username) { return this.getUserAggregate(teamId, username); }

  async getAllParticipants(teamId) {
    const t = sanitizeTeamId(teamId);
    const users = await this.redis.smembers(K.gwUsers(t));
    const result = [];
    for (const u of users) result.push(await this.getUserAggregate(t, u));
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
    await this.redis.del(K.gwChannels(t)); // Kanal-Cache invalidieren
    console.log(`[WTE] [${t}] opened, keyword="${keyword}", session=${sessionId}`);
  }

  async drawWinner(teamId, sessionId, opts = {}) {
    const t = sanitizeTeamId(teamId);
    const isTest = !!opts.test;
    const prize  = opts.prize ? sanitizeStr(opts.prize, 100) : null;
    const participants = await this.getAllParticipants(t);
    const eligible = participants.filter(p => p.eligible);
    if (!eligible.length) return null;

    const total = eligible.reduce((s, p) => s + p.totalCoins, 0);
    const rand  = (randomInt(0, 2 ** 31) / (2 ** 31)) * total;
    let acc = 0, winner = eligible[eligible.length - 1];
    for (const p of eligible) { acc += p.totalCoins; if (rand < acc) { winner = p; break; } }

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
      const idxRes = await client.query(
        sessionId ? `SELECT COUNT(*)::int AS n FROM giveaway_draws WHERE session_id=$1`
                  : `SELECT COUNT(*)::int AS n FROM giveaway_draws WHERE session_id IS NULL AND drawn_at > NOW() - INTERVAL '1 day'`,
        sessionId ? [sessionId] : []);
      drawIndex = (idxRes.rows[0]?.n || 0) + 1;
      const ins = await client.query(`
        INSERT INTO giveaway_draws
          (session_id, winner, winner_coins, winner_watch_sec, total_coins,
           eligible_count, rand_value, draw_index, is_test, prize, eligible_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
      `, [sessionId || null, winner.username, winner.totalCoins, Math.round(winner.totalWatchSec),
          totalRounded, eligible.length, randRounded, drawIndex, isTest, prize, JSON.stringify(snapshot)]);
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
                                           [winner.username, Math.round(winner.totalWatchSec), winner.totalCoins, sessionId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); console.error('[WTE] drawWinner error:', e.message); throw e;
    } finally { client.release(); }

    console.log(`[WTE] [${t}] Draw #${drawId}: ${winner.username} won, coins=${winner.totalCoins}, eligible=${eligible.length}, test=${isTest}`);
    return { winner: winner.username, coins: winner.totalCoins, watchSec: Math.round(winner.totalWatchSec),
             drawId, drawIndex, eligibleCount: eligible.length, total: totalRounded, rand: randRounded, isTest, prize };
  }

  async closeGiveaway(teamId, sessionId) {
    const t = sanitizeTeamId(teamId);
    await this.redis.set(K.gwOpen(t), 'false');
    await this.redis.srem(K.openTeams(), t);
    if (!sessionId) return;
    const participants = await this.getAllParticipants(t);
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
    const pipeline = this.redis.pipeline();
    for (const u of users) {
      pipeline.del(K.gwRegistered(t, u));
      pipeline.del(K.gwBanned(t, u));
      pipeline.srem(K.userTeams(u), t);
      pipeline.del(K.abuseHist(t, u), K.abuseTimes(t, u));
      for (const ch of channels) {
        pipeline.del(K.chWatch(t, ch, u), K.chChatTs(t, ch, u), K.chPresent(t, ch, u),
                     K.chLastTick(t, ch, u), K.chMsgs(t, ch, u), K.chFollows(t, ch, u));
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

    const participants = [];
    for (const u of users) {
      const perChannel = {};
      for (const ch of channels) {
        const watchSec = parseFloat(await this.redis.get(K.chWatch(t, ch, u)) || '0');
        const msgs     = parseInt(await this.redis.get(K.chMsgs(t, ch, u)) || '0');
        const follows  = await this.redis.get(K.chFollows(t, ch, u));
        if (!watchSec && !msgs && follows === null) continue;   // nie aktiv gewesen
        perChannel[ch] = { watchSec, msgs, follows };
      }
      participants.push({
        username: u,
        registered: await this.redis.get(K.gwRegistered(t, u)) === '1',
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

    let users = 0, channelsTouched = new Set();
    for (const p of data.participants) {
      const u = sanitizeUsername(p && p.username);
      if (!u) continue;
      users++;
      await this._touchUser(t, u);
      if (p.registered) await this.redis.set(K.gwRegistered(t, u), '1');
      if (p.banned)     await this.redis.set(K.gwBanned(t, u), '1');
      for (const [rawCh, v] of Object.entries(p.perChannel || {})) {
        const ch = sanitizeChannel(rawCh);
        if (!ch || !v) continue;
        channelsTouched.add(ch);
        await this.redis.sadd(K.chIndex(t, ch), u);
        const watchSec = Math.max(0, parseFloat(v.watchSec) || 0);
        const msgs     = Math.max(0, parseInt(v.msgs) || 0);
        if (mode === 'merge') {
          if (watchSec) await this.redis.incrbyfloat(K.chWatch(t, ch, u), watchSec);
          if (msgs)     await this.redis.incrby(K.chMsgs(t, ch, u), msgs);
        } else {
          await this.redis.set(K.chWatch(t, ch, u), String(watchSec));
          await this.redis.set(K.chMsgs(t, ch, u), String(msgs));
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
