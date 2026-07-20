'use strict';

// ════════════════════════════════════════════════════════
// Twitch Helix — Follow-Reconcile (Phase 4)
// Verifiziert vor der Ziehung, wer welchen Kanälen wirklich folgt.
// Pro Kanal wird die Follower-Liste über den Token des Kanal-Owners
// gelesen (Scope moderator:read:followers, self = broadcaster). User-IDs
// werden gecacht (Redis). Token-Refresh via refresh_token.
// ════════════════════════════════════════════════════════

const AUTH = 'https://id.twitch.tv/oauth2';
const API  = 'https://api.twitch.tv/helix';

class Helix {
  constructor({ clientId, clientSecret, pg, redis }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.pg = pg;
    this.redis = redis;
  }

  get configured() { return !!(this.clientId && this.clientSecret); }

  // App-Token (client_credentials) für /users-Lookups, in Redis gecacht.
  async appToken() {
    const cached = await this.redis.get('helix:apptoken');
    if (cached) return cached;
    const r = await fetch(`${AUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }),
    }).then(x => x.json());
    if (!r.access_token) throw new Error('app token failed');
    await this.redis.set('helix:apptoken', r.access_token, 'EX', Math.max(60, (r.expires_in || 3600) - 120));
    return r.access_token;
  }

  async _get(url, token) {
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': this.clientId } });
    if (res.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
    if (!res.ok) throw new Error('helix ' + res.status);
    return res.json();
  }

  // login → { id, createdAt } (gecacht 24h).
  async resolveUserMeta(login) {
    const l = String(login || '').toLowerCase();
    if (!l) return { id: null, createdAt: null };
    const key = 'helix:umeta:' + l;
    const cached = await this.redis.get(key);
    if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
    let meta = { id: null, createdAt: null };
    try {
      const d = await this._get(`${API}/users?login=${encodeURIComponent(l)}`, await this.appToken());
      const x = d.data && d.data[0];
      if (x) meta = { id: x.id, createdAt: x.created_at || null };
    } catch(e) { return { id: null, createdAt: null }; }
    await this.redis.set(key, JSON.stringify(meta), 'EX', 86400);
    return meta;
  }
  async resolveUserId(login) { return (await this.resolveUserMeta(login)).id; }

  // Gültiges Owner-Token (Kanal-Login) — refresht bei Ablauf. Null wenn
  // der Streamer den Scope nie erteilt hat.
  async validOwnerToken(login) {
    const l = String(login || '').toLowerCase();
    const r = await this.pg.query('SELECT access_token, refresh_token, token_expires FROM streamers WHERE login=$1', [l]);
    const row = r.rows[0];
    if (!row || !row.access_token) return null;
    const exp = row.token_expires ? new Date(row.token_expires).getTime() : 0;
    if (exp && exp - 60000 > Date.now()) return row.access_token;
    if (!row.refresh_token) return row.access_token; // kein Refresh möglich – letzter Versuch
    // Refresh
    try {
      const t = await fetch(`${AUTH}/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
          grant_type: 'refresh_token', refresh_token: row.refresh_token }),
      }).then(x => x.json());
      if (!t.access_token) return null;
      const expires = new Date(Date.now() + (t.expires_in || 14400) * 1000);
      await this.pg.query('UPDATE streamers SET access_token=$1, refresh_token=$2, token_expires=$3 WHERE login=$4',
        [t.access_token, t.refresh_token || row.refresh_token, expires, l]);
      return t.access_token;
    } catch(e) { return null; }
  }

  // Set aller Follower-user_ids eines Kanals (broadcaster_id) via Owner-Token.
  async getFollowerIds(ownerToken, broadcasterId) {
    const ids = new Set();
    let cursor = '';
    for (let page = 0; page < 200; page++) {   // Safety-Cap: 20k Follower
      const url = `${API}/channels/followers?broadcaster_id=${broadcasterId}&first=100` + (cursor ? `&after=${cursor}` : '');
      const d = await this._get(url, ownerToken);
      for (const f of (d.data || [])) ids.add(f.user_id);
      cursor = d.pagination && d.pagination.cursor ? d.pagination.cursor : '';
      if (!cursor) break;
    }
    return ids;
  }
}

module.exports = { Helix };
