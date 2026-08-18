'use strict';

// ════════════════════════════════════════════════════════
// Guthaben-Konto für CORE_TicketBuy (docs/ARCHITEKTUR-CORES.md §5.2/§10.1)
//
// Entscheidung §10.1: Guthaben ist TEAM-weit und wandert ins nächste
// Giveaway — darum lebt es hier in Postgres (credit_ledger, append-only),
// nicht in Redis und nicht unter t:<team>:g:<id>:. Der Kontostand ist die
// Summe der Bewegungen; gelöscht wird nie, korrigiert wird per Gegenbuchung.
//
// NUR die Engine bucht (eine Stelle, die falsch sein kann). Cores
// beschreiben Buchungen, führen sie aber nicht selbst aus. Ausnahme:
// die DSGVO-Löschung im admin-Service bucht den Restsaldo aus und
// pseudonymisiert — dokumentiert in eraseSubject().
//
// Leitplanken gegen Währungscharakter (§10.1): kein Kauf, kein Barwert,
// kein Umtausch, keine Übertragung zwischen Zuschauern — es gibt schlicht
// keine Buchungstypen dafür. Verfall nach EXPIRE_MONTHS ohne Bewegung.
// ════════════════════════════════════════════════════════

// Vorzeichen je Buchungstyp — erzwungen, damit kein Aufrufer ein
// „negatives Verdienen" oder eine „positive Abbuchung" einschleusen kann.
const ENTRY = Object.freeze({
  earn:   +1,   // erspielte Zuschauzeit wird Guthaben (beim Abschluss der Quelle)
  refund: +1,   // Einsatz vor Einsatz-Ende zurückgenommen
  wager:  -1,   // Einsatz auf einen Preis gesetzt
  debit:  -1,   // Einsatz nach der Ziehung verbraucht (alle Setzer, §5.2)
  expire: -1,   // Verfall nach Inaktivität
  erase:  -1,   // DSGVO-Löschung: Restsaldo ausgebucht
  reset:  -1,   // Losanpassung: Admin nullt alle Konten des Teams (Neustart)
});

const EXPIRE_MONTHS = 12;

class CreditLedger {
  constructor(pg) { this.pg = pg; }

  async balance(teamId, username, client = null) {
    const q = client || this.pg;
    const r = await q.query(
      `SELECT COALESCE(SUM(amount),0) AS bal FROM credit_ledger WHERE team_id=$1 AND username=$2`,
      [teamId, username]);
    return Math.round((parseFloat(r.rows[0].bal) || 0) * 10000) / 10000;
  }

  // Einzige Buchungsstelle. amount ist immer POSITIV — das Vorzeichen kommt
  // aus dem Typ. client: optionaler TX-Client (afterDraw läuft in derselben
  // Transaktion wie das Schreiben der Ziehung, §4).
  async book(teamId, username, type, amount, { refSession = null, refPrize = null, detail = null, client = null } = {}) {
    const sign = ENTRY[type];
    if (!sign) throw new Error('Unbekannter Buchungstyp: ' + type);
    const amt = Math.round(parseFloat(amount) * 10000) / 10000;
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Betrag muss > 0 sein');
    const value = sign * amt;
    const q = client || this.pg;
    await q.query(
      `INSERT INTO credit_ledger (team_id, username, entry_type, amount, ref_session, ref_prize, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [teamId, username, type, value, refSession, refPrize, detail ? JSON.stringify(detail) : null]);
    return value;
  }

  async statement(teamId, username, limit = 100) {
    const r = await this.pg.query(
      `SELECT id, entry_type, amount, ref_session, ref_prize, detail, created_at
       FROM credit_ledger WHERE team_id=$1 AND username=$2
       ORDER BY created_at DESC, id DESC LIMIT $3`, [teamId, username, limit]);
    return r.rows;
  }

  // Verfall nach `months` ohne jede Bewegung (Entscheidung §10.1:
  // Datenminimierung + kein unbegrenzt wachsendes Konto). Bucht den
  // Restsaldo aus — löscht nichts, das Journal bleibt nachvollziehbar.
  async expireInactive(months = EXPIRE_MONTHS) {
    const r = await this.pg.query(
      `SELECT team_id, username, SUM(amount) AS bal
       FROM credit_ledger
       GROUP BY team_id, username
       HAVING SUM(amount) > 0 AND MAX(created_at) < NOW() - ($1 || ' months')::interval`,
      [String(months)]);
    let n = 0;
    for (const row of r.rows) {
      await this.book(row.team_id, row.username, 'expire', parseFloat(row.bal),
                      { detail: { reason: 'inactivity', months } });
      n++;
    }
    return n;
  }
}

module.exports = { CreditLedger, ENTRY, EXPIRE_MONTHS };
