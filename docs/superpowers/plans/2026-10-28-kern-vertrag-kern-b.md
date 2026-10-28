# Teilprojekt 2 „Kern-Vertrag + Kern B“ – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Rahmen kennt Giveaways: Kern-Vertrag (`kernel-api`), Kern-Registry, Giveaway-Strom mit Lebenszyklus, Anmeldung, Kern-Befehlen, Ziehung (inkl. Ersatzziehung und Rückgängig), Lesetabellen und Zeitgeber – und Kern B „Sofortverlosung“ als erster Kern, vollständig über `CommandBus.execute`.

**Architecture:** Ein Giveaway ist ein Strom `giveaway:<uuid>`. Ein `StreamReducer<GiveawayState>` hält Rahmen-Zustand (Status, Anmeldungen, Ziehungen, Gewinner) und ruft für freigegebene Ereignisse `kernel.reduce`. Jeder Befehl ist ein `CommandHandler`; Kern-Befehle laufen über `kernel.decide`. Lesetabellen (`giveaways`, `giveaway_participants`, `timers`) werden aus dem **Zustand nach dem Befehl** geschrieben (neuer `StateProjector`) und lassen sich je Strom neu aufbauen. Der Scheduler hält einen `pg_advisory_lock` (genau eine Instanz) und führt fällige `timers` als Befehle aus. Es gibt in diesem Teilprojekt noch keine HTTP-Befehlsrouten und keine Konten – Rechte sind eine injizierte Schnittstelle, Tests nutzen `allowAll`.

**Tech Stack:** wie Teilprojekt 1 (Node 24, TypeScript NodeNext strict, Fastify, `pg`, `ioredis`, `zod` 4, Vitest, Testcontainers PG 17). Neu: `node:crypto` (`randomInt`, `createHash`) im Rahmen.

**Spec:** `C:\Users\streamer\Documents\Projekte\CC\CC-Giveaway-NG\NEW_DESIGN.md` – vollständig lesen. Relevant hier: §3.3–3.4, §4, §5.3–5.4, §6.4, §7, §8.2, §11.6, §12.1–12.2, §14 Punkt 2. Code-Repo: `C:\Users\streamer\Documents\Projekte\CC\CC-Giveaway-NG` (Branch `main`, Stand `210f390`). Alle Pfade unten relativ zu `packages/server/`, sofern nicht anders gesagt.

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`. Kein zweiter Schreibweg, auch nicht im Scheduler (§3.3). Nur `test/journal.test.ts`/`test/projections.test.ts` rufen `appendLocked` direkt (NG `CLAUDE.md`).
- `events` append-only. `reduce`, `pool`, `decide`, `viewerView`, `timers`, `gateRegistration` eines Kerns sind rein: kein I/O, keine Uhrzeit, kein Zufall – Zeit kommt als Feld (§4).
- Ein Kern importiert nur `src/kernel-api` (ESLint, Task 2 aus TP1). `src/kernels/` bleibt flach: `src/kernels/<id>/index.ts`, keine Datei direkt in `src/kernels/` (die Lint-Regel rechnet mit `../../kernel-api`).
- `kernel-api` importiert nichts aus `src` und keine I/O-Bibliothek (ESLint).
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity`). `pid` ist eine UUID.
- Umkehrarten exakt `compensate` | `void` | `none`; Ziehung = `void` (§5.3). `reason` Pflicht bei Umkehrungen.
- Zustände exakt (§7.1): `draft`, `open`, `paused`, `closed`, `drawn`, `completed`, `cancelled`. Übergänge exakt wie Tabelle §7.1. `closed → open` nur ohne gültige Ziehung. `cancelled` aus jedem Zustand außer `completed`.
- Ziehung: CSPRNG, `drawMode` des Kerns, Ereignis speichert Zufallswert(e), Topf-Hash, `{pid, weight}`-Liste, Bedingungsprüfung je Teilnehmer, Gewinner (§7.2). Gewinnerzahl einstellbar, Default 1. Ersatzziehung = alte Ziehung `void` + neue ohne alten Gewinner, in **einem** Befehl. Leerer Topf → kein `drawn`, Ablehnung mit Erklärung.
- Gewinnerabwicklung (§7.3): Meldefrist je Giveaway, Default 14 Tage (`claimDays`, 1–90). Stati exakt `reported` (gemeldet), `shipped` (versendet), `done` (erledigt), `forfeited` (verfallen), davor `pending`. Keine Kontaktdaten.
- Kern B (§8.2): `id: 'instant'`, Dienste nur `registration`, Fenster mehrfach öffnen/schließen im Zustand `open`, Teilnehmer akkumulieren, Gewicht 1, `drawMode: 'equal'`, Parameter Fensterlänge Default 120 s, Bereich 10–3600 s, keine eingebauten Schwellen, `supportedGates: ['follow', 'account_age']`, `display.beta = true`.
- Snapshot alle 1.000 Ereignisse; ändert sich eine Kern-Version, dürfen alte Snapshots nicht mehr greifen (§4, §5.4).
- Neue Tabellen/Spalten nur über eine neue Datei in `migrations/` (`003_giveaways.sql`).
- Scheduler: genau eine Instanz, abgesichert über `pg_advisory_lock`; Fensterende setzt der Scheduler per Befehl (§3.1, §6.3 analog).
- Fehler-/UI-Texte deutsch, kurz, aktiv, Glossar-Begriffe, „was passiert ist + was zu tun ist“ (§11.6). Keine Werbewörter. Kein Semikolon.
- Tests brauchen Docker (Testcontainers). Kern-Tests (`test/instant-kernel.test.ts`, `test/draw.test.ts`, `test/kernel-config.test.ts`) laufen ohne Datenbank.
- Commits auf `main` im NG-Repo, Message deutsch im Stil von TP1 (`feat(kernel): …`), Trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Festlegungen dieses Plans (Betreiber: bitte bestätigen oder kippen)

Die Spec lässt diese Punkte offen. Der Plan legt sie fest, jede Festlegung ist in einem Task als Test belegt:

| # | Festlegung | Grund |
|---|---|---|
| F1 | `pid` = UUID und zugleich Konto-ID. Akteur eines Teilnehmers ist `user:<pid>`. | §9.1 „Ein Twitch-Konto hat genau eine pid“, Ströme `account:<id>`. Eine ID statt zwei. TP3 baut `identities` darauf. |
| F2 | `authorize` läuft **in der Transaktion vor der Stromsperre** mit DB-Zugriff (`c`), darf async sein. Eine Ablehnung (authorize oder decide) rollt zurück: kein `stream_heads`-Eintrag. | Ledger TP1 I-1. Rechte brauchen die Lesetabelle `giveaways` (Team). |
| F3 | Lesetabellen des Giveaways sind **zustandsbasiert** (`StateProjector`): der Bus gibt den Zustand nach dem Befehl weiter. Ereignis-Projektoren (`Projector`) bleiben für Zähler/Journale. | Gewichte kommen aus `kernel.pool(state)`, nicht aus einzelnen Ereignissen. Neuaufbau je Strom = Zustand laden + schreiben (Ledger I-3). |
| F4 | Reducer-Version für Snapshots = FNV-1a-Hash (31 Bit) über `rahmenVersion` + alle `kernelId@version`. Jede Kern-Änderung invalidiert alle Giveaway-Snapshots. | Vor dem ersten Ereignis ist der Kern eines Stroms unbekannt (Ledger-Gap). Snapshots sind Cache. |
| F5 | Lebenszyklus = ein Ereignistyp `giveaway_status_changed {from, to}`, Umkehr `compensate` → `{from: to, to: from}`, nur wenn `state.status === to` (sonst `not_latest_transition`). Ziehung separat `giveaway_drawn` (`void`). | §5.3 „Pause ↔ Fortsetzen“ compensate, §7.1 „jeder Übergang umkehrbar“. Ein Typ statt sieben, rückwärts immer sicher. |
| F6 | Kern-Ereignistypen heißen `<kernelId>_<name>` (z. B. `instant_window_opened`), die Registry erzwingt den Präfix. Kern-Ereignisse validieren über `check(payload): string \| null`, kein zod im Kern. | Namensraum-Konvention (Ledger-Gap), `kernel-api` ohne Abhängigkeiten. |
| F7 | Ein Kern erhält genau: eigene Ereignisse + `participant_registered` + `participant_withdrawn` (als `KernelEvent` mit `id`, `at`, `reversesEventId`). | §6.1 „nur freigegebene Ereignisse“. Gegen-Ereignisse müssen sichtbar sein (Ledger-Gap). |
| F8 | Kern kann Anmeldungen ablehnen: `gateRegistration?(state, config, now)`. Kern B: nur bei offenem, nicht abgelaufenem Fenster. | §8.2 Fenster = Anmeldephase. Anmeldung ist Rahmen-Dienst (§6.4), der Kern setzt die Regel. |
| F9 | Zeitgeber generisch: `kernel.timers?(state, config): TimerSpec[]`. Der Rahmen spiegelt sie in `timers`, der Scheduler führt fällige als `kernelCommand` mit Akteur `system:scheduler` aus. | §6.3 „Das Ende setzt der Scheduler per Befehl“, gilt später auch für Boost. Rein, testbar. |
| F10 | Kern-Befehle nur im Zustand `open`. Kern B: `open_window` (Streamer), `close_window` (Scheduler oder Streamer, ohne offenes Fenster = kein Ereignis). | §7.1 Kern B „im Zustand Offen“. Idempotent für den Scheduler. |
| F11 | `isReverted` wird **wirksam**: ein Ereignis gilt als aufgehoben, wenn eine nicht selbst aufgehobene Umkehrung existiert. | Ledger Task 10 minor (r1←r2←r3). Sonst UI-Durchstreichung falsch. |
| F12 | Akteur-Liste erweitert um `system:migration` (jetzt, für TP9). | §15.9. |
| F13 | Kein HTTP für Befehle, keine Rechtstexte-Pflicht beim Öffnen, keine Bedingungen (Gates) live – kommen TP3/TP5. Die Ziehung hat eine `GateChecker`-Schnittstelle; TP2 liefert `noGates` (alle erfüllt, `gates: []` im Ereignis). | §14 Reihenfolge. Struktur jetzt, Prüfung später. |
| F14 | Ein Kern-Versionssprung baut Lesetabellen laufender Giveaways (`draft/open/paused/closed`) beim App-Start neu auf (`reconcileKernelVersions`). `drawn/completed/cancelled` behalten die gespeicherte Version. | §4 „Abgeschlossene Giveaways behalten ihre Version“; nach der Ziehung ist der Topf im Ereignis festgehalten. |
| F15 | Meldefrist ist eine Einstellung des Giveaways (`claimDays`, Default 14, 1–90). Das Portal rechnet `Ziehungszeitpunkt + claimDays`. Kein eigenes Ereignis. | §7.3 „Meldefrist (Default 14 Tage)“. Einstellung statt Konstante, weil Streamer Fristen unterschiedlich setzen. |

## Review Focus

1. **Zwei `register` desselben `pid` gleichzeitig** → genau eine Anmeldung, die andere `already_registered`, kein doppeltes Ereignis. Test: Task 8 `parallel register of same pid yields one event`.
2. **Anmeldung nach Fensterende, bevor der Scheduler geschlossen hat** → abgelehnt (`window_closed`), obwohl `window` im Zustand noch steht. Test: Task 9 `rejects registration after until even if window not yet closed`.
3. **Ersatzziehung, wenn außer dem alten Gewinner niemand im Topf ist** → Ablehnung `empty_pool`, alte Ziehung bleibt gültig (nichts geschrieben). Test: Task 10 `redraw with nobody else leaves the old draw valid`.
4. **Kern-Version steigt bei laufendem Giveaway** → alter Snapshot wird ignoriert, Zustand aus Replay, Lesetabelle neu, abgeschlossenes Giveaway unverändert. Tests: Task 5 `version stamp changes with any kernel version`, Task 11 `reconcile rebuilds open giveaways only`.
5. **Ablehnung auf neuem Strom** (authorize oder decide) → keine `stream_heads`-Zeile, kein Ereignis, Ablehnung im `access_log`. Test: Task 2 `rejected command on a new stream leaves no stream_heads row`.

---

## Dateistruktur (Ziel nach Task 12)

```
packages/server/
├─ migrations/003_giveaways.sql          # giveaways, giveaway_participants, timers
├─ src/
│  ├─ kernel-api/index.ts                # Kern-Vertrag: Typen, Rejection, FRAMEWORK_EVENTS
│  ├─ kernels/instant/index.ts           # Kern B
│  ├─ shared/rejection.ts                # re-export aus kernel-api
│  ├─ journal/types.ts                   # ACTOR_RE + system:migration
│  ├─ journal/journal.ts                 # isReverted wirksam
│  ├─ framework/command-bus.ts           # authorize(c) vor Sperre, RejectionSignal, Zustand an Projektionen
│  ├─ framework/state.ts                 # loadStreamState (aus dem Bus herausgezogen)
│  ├─ framework/projections.ts           # StateProjector, applyState, rebuildStream, reset(stream)
│  ├─ framework/kernel-config.ts         # validateConfig
│  ├─ framework/kernel-registry.ts       # KernelRegistry, defaultKernels, versionStamp
│  ├─ framework/giveaway/state.ts        # GiveawayState, makeGiveawayReducer, toKernelEvent
│  ├─ framework/giveaway/events.ts       # registerGiveawayEvents
│  ├─ framework/giveaway/authorize.ts    # GiveawayAuthorizer, allowAll, denyUsers, loadGiveawayRow
│  ├─ framework/giveaway/lifecycle.ts    # create/open/pause/resume/close/reopen/cancel/complete/changeSettings
│  ├─ framework/giveaway/registration.ts # register, withdraw
│  ├─ framework/giveaway/kernel-command.ts # kernelCommand
│  ├─ framework/giveaway/draw.ts         # drawWinners, poolHash, GateChecker, draw, redraw, setWinnerStatus
│  ├─ framework/giveaway/projectors.ts   # giveawaysProjector (Task 7), participantsProjector, timersProjector, reconcileKernelVersions (Task 11)
│  ├─ framework/runtime.ts               # createRuntime: Registry + Kerne + Projektionen + Bus + Handler (Task 7, wächst bis Task 11)
│  ├─ scheduler/lock.ts                  # acquireSchedulerLock
│  ├─ scheduler/timers.ts                # runDueTimers
│  ├─ scheduler/main.ts · app/main.ts    # Verdrahtung
└─ test/
   ├─ helpers/giveaway.ts                # setupGiveaway, IDs, create/open-Helfer
   ├─ helpers/plain-kernel.ts            # Test-Kern ohne Fenster (Anmeldung ohne Kern-B-Gate testen)
   ├─ kernel-config.test.ts · kernel-registry.test.ts · instant-kernel.test.ts · draw.test.ts   (ohne DB)
   ├─ giveaway-state.test.ts · lifecycle.test.ts · registration.test.ts · kernel-command.test.ts
   ├─ draw-command.test.ts · giveaway-projections.test.ts · scheduler-timers.test.ts
   └─ command-bus.test.ts · revert.test.ts · journal.test.ts · projections.test.ts (ergänzt)
```

---

### Task 1: Kern-Vertrag `kernel-api`

**Files:**
- Create: `src/kernel-api/index.ts`
- Modify: `src/shared/rejection.ts` (wird Re-Export)
- Test: `test/kernel-api.test.ts`, `test/architecture.test.ts` (ein Fall ergänzen)

**Interfaces:**
- Consumes: nichts (ESLint verbietet Imports).
- Produces (`src/kernel-api/index.ts`, alles exportiert):
  ```ts
  export type Pid = string;                                   // UUID (F1)
  export type GateId = 'follow' | 'account_age' | 'follow_age' | 'presence';
  export type ServiceId = 'watchtime' | 'chatBonus' | 'boost' | 'registration';
  export type DrawMode = 'weighted' | 'equal' | 'highest';
  export interface Rejection { rejected: true; code: string; message: string }
  export function reject(code: string, message: string): Rejection;
  export function isRejection(x: unknown): x is Rejection;
  export type ConfigField =
    | { kind: 'int'; label: string; help: string; default: number; min: number; max: number; unit?: 'sec' | 'coins' }
    | { kind: 'bool'; label: string; help: string; default: boolean }
    | { kind: 'text'; label: string; help: string; default: string; maxLength: number };
  export type ConfigSchema<C> = { readonly [K in keyof C]: ConfigField };
  export const FRAMEWORK_EVENTS = { registered: 'participant_registered', withdrawn: 'participant_withdrawn' } as const;
  export interface KernelEvent { id: string; type: string; payload: unknown; at: string /* ISO */; reversesEventId: string | null }
  export interface NewKernelEvent { type: string; payload: unknown }
  export interface PoolEntry { pid: Pid; weight: number }
  export interface KernelCommand { type: string; pid?: Pid; args: Record<string, unknown> }
  export interface KernelCommandSpec { type: string; label: string; issuer: 'participant' | 'streamer' | 'scheduler' }
  export type KernelReversal =
    | { kind: 'compensate'; inverse: (payload: unknown) => NewKernelEvent | Rejection }
    | { kind: 'void' }
    | { kind: 'none'; why: string };
  export interface KernelEventDef { type: string; version: number; check(payload: unknown): string | null; reversal: KernelReversal }
  export interface TimerSpec { key: string; dueAt: string /* ISO */; command: KernelCommand }
  export interface ViewerView { registered: boolean; inPool: boolean; weight: number; lines: { label: string; value: string }[] }
  export interface DisplaySpec { icon: string; unit: string | null; beta: boolean; emptyPool: string; columns: { key: string; label: string }[] }
  export interface Kernel<Config, State> {
    id: string; version: number; label: string;
    configSchema: ConfigSchema<Config>;
    supportedGates: readonly GateId[];
    usesServices: readonly ServiceId[];
    drawMode: DrawMode;
    events: readonly KernelEventDef[];
    commands: readonly KernelCommandSpec[];
    initialState(config: Config): State;
    reduce(state: State, event: KernelEvent, config: Config): State;
    pool(state: State, config: Config): PoolEntry[];
    decide?(state: State, cmd: KernelCommand, config: Config, now: string): NewKernelEvent[] | Rejection;
    gateRegistration?(state: State, config: Config, now: string): Rejection | null;
    timers?(state: State, config: Config): TimerSpec[];
    viewerView(state: State, pid: Pid, config: Config): ViewerView;
    display: DisplaySpec;
  }
  export type AnyKernel = Kernel<any, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any – Registry-Typ
  ```
- `src/shared/rejection.ts` wird: `export { reject, isRejection, type Rejection } from '../kernel-api/index.js';` – alle bestehenden Importe bleiben gültig.

- [ ] **Step 1: Failing test schreiben** – `test/kernel-api.test.ts`:
  - `reject('x', 'y')` ergibt `{ rejected: true, code: 'x', message: 'y' }`, `isRejection` erkennt es, `isRejection(null)`/`isRejection({})` sind `false`.
  - `FRAMEWORK_EVENTS` ist exakt `{ registered: 'participant_registered', withdrawn: 'participant_withdrawn' }`.
  - Typ-Test (kompiliert, kein Laufzeit-Assert nötig): ein `Kernel<{ n: number }, { x: number }>`-Literal mit allen Pflichtfeldern ist zuweisbar, eines ohne `pool` nicht (`// @ts-expect-error`).
  - Ergänze in `test/architecture.test.ts`: `kernel-api darf zod nicht importieren` → `restricted('src/kernel-api/index.ts', "import { z } from 'zod';\nexport const y = z;\n")` ist `true` (dazu in `eslint.config.js` für `src/kernel-api/**` das Pattern `{ regex: '^zod$', message: 'kernel-api bleibt frei von Bibliotheken.' }` ergänzen).
- [ ] **Step 2: Test laufen lassen** – `npx vitest run test/kernel-api.test.ts test/architecture.test.ts` → FAIL (Modul fehlt / Lint-Fall rot).
- [ ] **Step 3: `src/kernel-api/index.ts` schreiben** mit genau den Exporten oben, `shared/rejection.ts` auf Re-Export umstellen, ESLint-Pattern ergänzen.
- [ ] **Step 4: Prüfen** – `npm run typecheck && npm run lint && npx vitest run test/kernel-api.test.ts test/architecture.test.ts test/revert.test.ts` → alles grün (revert nutzt weiter `reject`).
- [ ] **Step 5: Commit** – `feat(kernel-api): Kern-Vertrag als Typen, Rejection zieht um`

---

### Task 2: Command-Bus – Rechte vor der Sperre, Ablehnung rollt zurück, Zustand an Projektionen

**Files:**
- Modify: `src/framework/command-bus.ts`, `src/framework/projections.ts`
- Create: `src/framework/state.ts`
- Modify: `test/helpers/fixtures.ts`, `test/command-bus.test.ts`, `test/projections.test.ts`

**Interfaces:**
- Consumes: TP1 (`lockStream`, `appendLocked`, `readStream`, `loadSnapshot`, `saveSnapshot`, `logDenied`).
- Produces:
  ```ts
  // state.ts
  export async function loadStreamState<S>(c: pg.PoolClient, registry: EventTypeRegistry, stream: StreamId, reducer: StreamReducer<S>): Promise<S>;
  // command-bus.ts – geänderte Signatur
  export interface CommandHandler<C, S, P = undefined> {
    type: string;
    streamOf(cmd: C): StreamId;
    reducer: StreamReducer<S>;
    /** In der Transaktion, VOR der Stromsperre. Darf lesen. */
    authorize(cmd: C, ctx: CommandContext, c: pg.PoolClient): Rejection | null | Promise<Rejection | null>;
    prepare?(c: pg.PoolClient, cmd: C, ctx: CommandContext): Promise<P>;
    decide(state: S, cmd: C, ctx: CommandContext, prepared: P): NewEvent[] | Rejection;
  }
  export class CommandBus { /* execute wie bisher; loadState delegiert an loadStreamState */ }
  // projections.ts
  export interface Projector { name; handles; apply(c, e); reset(c: pg.PoolClient, stream?: StreamId): Promise<void> }
  export interface StateProjector<S> {
    name: string;
    reducer: string;                                   // StreamReducer.name, auf den er hört
    apply(c: pg.PoolClient, stream: StreamId, state: S, head: { seq: number; at: Date }): Promise<void>;
    reset(c: pg.PoolClient, stream?: StreamId): Promise<void>;
  }
  export class ProjectionRegistry {
    register(p: Projector): void;
    registerState<S>(p: StateProjector<S>): void;
    applyAll(c, events): Promise<void>;                // unverändert
    applyState<S>(c, stream, reducerName: string, state: S, head: { seq: number; at: Date }): Promise<void>;
    rebuild(pool, registry, name, batchSize?): Promise<number>;   // unverändert (Ereignis-Projektor)
    rebuildStream<S>(pool, registry, stream, reducer: StreamReducer<S>): Promise<void>;  // alle StateProjector des Reducers: reset(stream) + apply
  }
  ```
- Bus-Ablauf neu (in `withTx`): `authorize` → bei Ablehnung `throw new RejectionSignal(r)` → `lockStream` → `loadStreamState` → `prepare` → `decide` → bei Ablehnung `throw new RejectionSignal(r)` → `appendLocked` → `next = events.reduce(reducer.apply, state)` → `projections.applyAll` → `projections.applyState(c, stream, reducer.name, next, {seq: lastSeq+events.length, at: ctx.now})` → Snapshot (nutzt `next`, rechnet nicht erneut). `execute` fängt `RejectionSignal` außerhalb der Transaktion und ruft `deny` (Rollback ist dann schon passiert). `RejectionSignal` ist eine lokale Klasse, nicht exportiert.

- [ ] **Step 1: Fixtures anpassen** – `incrementHandler.authorize` erhält die neue Signatur (sync bleibt erlaubt). Neu in fixtures: `export const totalsStateProjector: StateProjector<CounterState>` (`reducer: 'counter'`, schreibt `test_state_totals (stream TEXT PRIMARY KEY, total INT, seq INT)`, `reset(c, stream?)` löscht nur den Strom, wenn gegeben).
- [ ] **Step 2: Failing tests schreiben** – in `test/command-bus.test.ts` ergänzen:
  - `rejected command on a new stream leaves no stream_heads row`: decide-Ablehnung (`by: 500`) auf frischem Strom → `SELECT count(*) FROM stream_heads` = 0, `access_log` hat den Eintrag.
  - `authorize may read the database and runs before the lock`: Handler mit `authorize: async (cmd, ctx, c) => (await c.query('SELECT 1 AS n')).rows[0].n === 1 ? reject('seen_db', 'x') : null` → Ablehnung `seen_db`, keine `stream_heads`-Zeile.
  - `state projector receives the state after the command`: `registerState(totalsStateProjector)`, zwei Befehle `by: 3`, `by: 4` → `test_state_totals` = `{ total: 7, seq: 2 }`.
  - `state projector failure rolls back the command` (analog zum bestehenden Projektions-Test).
  - In `test/projections.test.ts`: `rebuildStream resets only that stream and equals the live state`: zwei Ströme beschreiben, `UPDATE test_state_totals SET total = 999`, `rebuildStream(pool, registry, STREAM, counterReducer)` → `STREAM` korrekt, `OTHER_STREAM` weiter 999. Zum Schreiben hier der `CommandBus` (die Datei darf `appendLocked` direkt rufen, aber `applyState` braucht den Zustand – der Bus ist einfacher).
- [ ] **Step 3: Tests laufen lassen** – `npx vitest run test/command-bus.test.ts test/projections.test.ts` → neue Fälle FAIL.
- [ ] **Step 4: Implementieren** – `state.ts`, Bus-Umbau wie oben, `ProjectionRegistry` erweitern (`applyState` ruft nur StateProjector mit passendem `reducer`; `rebuildStream` lädt in einer Transaktion über `loadStreamState` und ruft `reset(c, stream)` + `apply`). `maybeSnapshot` nimmt `next` als Parameter.
- [ ] **Step 5: Prüfen** – `npm run typecheck && npm run lint && npx vitest run test/command-bus.test.ts test/projections.test.ts test/revert.test.ts` → grün. Bestehende Fälle (`parallel commands keep seq gapless`, `two bus instances …`) unverändert grün.
- [ ] **Step 6: Commit** – `feat(framework): Rechte vor der Sperre, Ablehnung rollt zurück, Zustand an Projektionen`

---

### Task 3: Journal – wirksame Umkehrung, Akteur `system:migration`

**Files:**
- Modify: `src/journal/journal.ts` (`isReverted`), `src/journal/types.ts` (`ACTOR_RE`)
- Test: `test/journal.test.ts`, `test/revert.test.ts`

**Interfaces:**
- Produces: `isReverted(db, id): Promise<boolean>` – `true` nur, wenn eine Umkehrung existiert, die selbst nicht (wirksam) aufgehoben ist. Rekursiv über `reverses_event_id`, Tiefe ist durch die Kette begrenzt. Signatur unverändert.

- [ ] **Step 1: Failing tests** – `test/revert.test.ts`: `an event whose reversal was reverted can be reverted again`: `inc(4)` → revert r1 → revert r2 (hebt r1 auf) → erneut revert des `inc`-Ereignisses → `ok: true`, Endzustand `{ total: 0 }`. `test/journal.test.ts`: `assertActor accepts system:migration` und lehnt `system:unknown` ab.
- [ ] **Step 2: Laufen lassen** → FAIL (`already_reverted` bzw. `invalid_actor`).
- [ ] **Step 3: Implementieren** – `isReverted`: `SELECT id FROM events WHERE reverses_event_id = $1`, für jede Zeile rekursiv prüfen, `true`, sobald eine nicht aufgehobene Umkehrung gefunden ist. `ACTOR_RE`: `system:(ingest|scheduler|twitch|migration)`.
- [ ] **Step 4: Prüfen** – `npx vitest run test/journal.test.ts test/revert.test.ts` → grün.
- [ ] **Step 5: Commit** – `fix(journal): Umkehrung einer Umkehrung gibt das Ereignis wieder frei, Akteur system:migration`

---

### Task 4: Kern-Konfiguration prüfen

**Files:**
- Create: `src/framework/kernel-config.ts`
- Test: `test/kernel-config.test.ts` (ohne DB)

**Interfaces:**
- Consumes: `ConfigSchema`, `ConfigField`, `Rejection`, `reject` (Task 1).
- Produces:
  ```ts
  export function defaultConfig<C>(schema: ConfigSchema<C>): C;
  /** Fehlende Felder → Default. Unbekannte Felder → Ablehnung. Alle Fehler in einer Meldung, je Zeile „<label>: <was falsch ist>“. */
  export function validateConfig<C>(schema: ConfigSchema<C>, input: unknown): { ok: true; value: C } | Rejection;  // code 'invalid_config'
  ```

- [ ] **Step 1: Failing tests** – Schema `{ windowSec: { kind: 'int', label: 'Fensterlänge', help: '…', default: 120, min: 10, max: 3600, unit: 'sec' }, announce: { kind: 'bool', …, default: true }, note: { kind: 'text', …, default: '', maxLength: 20 } }`:
  - `defaultConfig` → `{ windowSec: 120, announce: true, note: '' }`.
  - `validateConfig(schema, {})` → `{ ok: true, value: defaults }`.
  - `validateConfig(schema, { windowSec: 5, announce: 'ja', note: 'x'.repeat(21), extra: 1 })` → `rejected`, `code: 'invalid_config'`, `message` enthält vier Zeilen: `Fensterlänge: Erlaubt ist eine ganze Zahl von 10 bis 3600.`, `announce …: Erlaubt ist an oder aus.`, `note …: Höchstens 20 Zeichen.`, `extra: Dieses Feld gibt es nicht.`
  - `validateConfig(schema, { windowSec: 10.5 })` → abgelehnt (ganze Zahl). `validateConfig(schema, null)` → abgelehnt `Die Einstellungen fehlen.`
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren** – ohne zod, reine Schleife über die Schema-Schlüssel.
- [ ] **Step 4: Prüfen** – `npx vitest run test/kernel-config.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(framework): Kern-Konfiguration prüfen und mit Defaults füllen`

---

### Task 5: Kern-Registry und Kern B „Sofortverlosung“

**Files:**
- Create: `src/kernels/instant/index.ts`, `src/framework/kernel-registry.ts`
- Test: `test/instant-kernel.test.ts`, `test/kernel-registry.test.ts` (beide ohne DB)

**Interfaces:**
- Consumes: Task 1, Task 4 (`defaultConfig` nur im Test).
- Produces:
  ```ts
  // kernels/instant/index.ts
  export interface InstantConfig { windowSec: number }
  export interface InstantState { registered: Pid[] /* sortiert, eindeutig */; window: { until: string } | null; windowsOpened: number }
  export const INSTANT_EVENTS = { windowOpened: 'instant_window_opened', windowClosed: 'instant_window_closed' } as const;
  export const instantKernel: Kernel<InstantConfig, InstantState>;
  // kernel-registry.ts
  export const FRAMEWORK_REDUCER_VERSION = 1;
  export class KernelRegistry {
    register(k: AnyKernel): void;             // wirft bei doppelter id, bei Ereignistyp ohne Präfix `${id}_`, bei commands-Typ doppelt
    get(id: string): AnyKernel;               // JournalError('unknown_kernel', 'Unbekannter Kern: <id>. Prüfe die Registry.')
    has(id: string): boolean;
    list(): AnyKernel[];
    versionStamp(): number;                   // = versionStamp(FRAMEWORK_REDUCER_VERSION, this.list())
  }
  /** FNV-1a 32 Bit über `${frameworkVersion}` + je Kern `${id}@${version}` (nach id sortiert), & 0x7fffffff (F4). Rein. */
  export function versionStamp(frameworkVersion: number, kernels: readonly { id: string; version: number }[]): number;
  export function defaultKernels(): KernelRegistry;   // registriert instantKernel
  ```
- Kern B festgelegt:
  - `id 'instant'`, `version 1`, `label 'Sofortverlosung'`, `drawMode 'equal'`, `supportedGates ['follow','account_age']`, `usesServices ['registration']`.
  - `configSchema.windowSec`: `{ kind: 'int', label: 'Fensterlänge', help: 'So lange ist das Anmeldefenster offen.', default: 120, min: 10, max: 3600, unit: 'sec' }`.
  - `events`: `instant_window_opened {until: ISO}` v1, `check` verlangt gültiges ISO-Datum, reversal `compensate` → `{ type: 'instant_window_closed', payload: {} }`. `instant_window_closed {}` v1, reversal `none`, why `'Ein geschlossenes Fenster bleibt zu. Öffne ein neues Fenster.'`
  - `commands`: `{ type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' }`, `{ type: 'close_window', label: 'Anmeldefenster schließen', issuer: 'scheduler' }`.
  - `decide`: `open_window` mit `args.windowSec` optional (Zahl im Schema-Bereich, sonst `reject('invalid_window', 'Die Fensterlänge muss zwischen 10 und 3600 Sekunden liegen.')`), bei offenem Fenster `reject('window_open', 'Ein Anmeldefenster ist schon offen. Schließe es zuerst.')`, sonst `[{ type: windowOpened, payload: { until: now + sec } }]`. `close_window`: ohne Fenster `[]`, sonst `[{ type: windowClosed, payload: {} }]`. Unbekannter Typ → `reject('unknown_command', 'Diesen Befehl kennt die Sofortverlosung nicht.')`.
  - `reduce`: `participant_registered {pid}` → pid einfügen (sortiert), `participant_withdrawn {pid}` → entfernen, `windowOpened` → `window = {until}`, `windowsOpened + 1`, `windowClosed` → `window = null`. Unbekannte Typen → Zustand unverändert.
  - `gateRegistration(state, config, now)`: kein Fenster oder `now >= until` → `reject('window_closed', 'Das Anmeldefenster ist zu. Warte auf das nächste Fenster.')`.
  - `timers`: Fenster offen → `[{ key: 'window_end', dueAt: until, command: { type: 'close_window', args: {} } }]`, sonst `[]`.
  - `pool`: `registered.map(pid => ({ pid, weight: 1 }))`.
  - `viewerView`: `registered`, `inPool = registered`, `weight 1|0`, `lines: [{ label: 'Anmeldefenster', value: 'offen bis <ISO>' | 'geschlossen' }]`.
  - `display`: `{ icon: '⚡', unit: null, beta: true, emptyPool: 'Niemand hat sich im Anmeldefenster angemeldet.', columns: [{ key: 'registered', label: 'Angemeldet' }] }`.

- [ ] **Step 1: Failing tests** – `test/instant-kernel.test.ts` (Hilfsfunktion `ev(type, payload, at = T0)` baut `KernelEvent`, `T0 = '2026-10-15T12:00:00.000Z'`):
  - `initialState` → `{ registered: [], window: null, windowsOpened: 0 }`.
  - `registered pids are unique and sorted`: zwei Mal `participant_registered` derselben pid + eine zweite → `registered` Länge 2, sortiert. `participant_withdrawn` entfernt.
  - `open_window uses config or args`: decide ohne args → `until = T0 + 120 s`, mit `args.windowSec: 30` → `+30 s`, `args.windowSec: 5` → `invalid_window`, Fenster offen → `window_open`.
  - `close_window is a no-op without window`: `[]`, mit Fenster → ein `instant_window_closed`.
  - `gateRegistration`: ohne Fenster `window_closed`, Fenster bis `T0+120` und `now = T0+60` → `null`, `now = T0+120` → `window_closed`.
  - `timers follow the window`: offen → ein Timer `window_end` mit `dueAt = until`, geschlossen → `[]`.
  - `pool weighs everyone 1 and participants accumulate across windows`: zwei Fenster nacheinander mit je einer Anmeldung → Topf 2 Einträge, Gewicht 1.
  - `reversal of window_opened is window_closed`: `events.find(windowOpened).reversal.inverse({until})` → `{ type: 'instant_window_closed', payload: {} }`.
  - Property (20 zufällige Ereignisfolgen mit festem Seed-Array, kein `Math.random` im Kern): `pool` deterministisch für gleichen Zustand, alle Gewichte ≥ 0, `registered` immer sortiert und eindeutig.
  - `test/kernel-registry.test.ts`: `defaultKernels().get('instant').id === 'instant'`, `get('nope')` wirft `unknown_kernel`, doppelt registrieren wirft, Kern mit Ereignistyp `foo_x` unter id `bar` wirft (`Präfix`). `version stamp changes with any kernel version`: `versionStamp(1, [{id:'a',version:1},{id:'b',version:1}])` gleich bei vertauschter Reihenfolge, ungleich zu `version: 2` bei `b`, ungleich zu `versionStamp(2, …)`, Ergebnis ganzzahlig in `[0, 2^31)`. `defaultKernels().versionStamp()` entspricht `versionStamp(FRAMEWORK_REDUCER_VERSION, [instantKernel])`.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren** – Kern B und Registry wie festgelegt. Kern B importiert nur `../../kernel-api/index.js`.
- [ ] **Step 4: Prüfen** – `npm run lint` (Lint-Regel greift jetzt erstmals auf einen echten Kern) und `npx vitest run test/instant-kernel.test.ts test/kernel-registry.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(kernel): Kern B Sofortverlosung und Kern-Registry`

---

### Task 6: Giveaway-Zustand und Ereignistypen

**Files:**
- Create: `src/framework/giveaway/state.ts`, `src/framework/giveaway/events.ts`
- Test: `test/giveaway-state.test.ts` (ohne DB – Ereignisse als `EventRecord`-Literale)

**Interfaces:**
- Consumes: `KernelRegistry` (Task 5), `EventTypeRegistry`, `registerRevertTypes`/`EVENT_VOIDED` (TP1), `validateConfig` (Task 4).
- Produces:
  ```ts
  // state.ts
  export type GiveawayStatus = 'draft' | 'open' | 'paused' | 'closed' | 'drawn' | 'completed' | 'cancelled';
  export type WinnerStatus = 'pending' | 'reported' | 'shipped' | 'done' | 'forfeited';
  export interface GateConfig { id: GateId; [k: string]: unknown }
  export interface GiveawaySettings { config: Record<string, unknown>; prize: string; sponsor: string | null; channels: Pid[]; winnersCount: number; claimDays: number; gates: GateConfig[] }
  export interface DrawRecord { eventId: string; winners: Pid[]; voided: boolean }
  export interface GiveawayState {
    exists: boolean; teamId: string; kernelId: string; kernelVersionAtCreate: number;
    settings: GiveawaySettings; status: GiveawayStatus;
    registered: Record<Pid, { since: string }>;
    draws: DrawRecord[];
    winners: Record<Pid, WinnerStatus>;          // Gewinner der gültigen Ziehung(en)
    kernelState: unknown;
  }
  export const GIVEAWAY_EVENTS = {
    created: 'giveaway_created', statusChanged: 'giveaway_status_changed', settingsChanged: 'giveaway_settings_changed',
    drawn: 'giveaway_drawn', winnerStatusSet: 'winner_status_set',
    registered: FRAMEWORK_EVENTS.registered, withdrawn: FRAMEWORK_EVENTS.withdrawn,
  } as const;
  export function giveawayStream(id: string): StreamId;                 // `giveaway:${id}`
  export function toKernelEvent(e: EventRecord): KernelEvent;           // id, type, payload, at = createdAt.toISOString(), reversesEventId
  export function makeGiveawayReducer(kernels: KernelRegistry): StreamReducer<GiveawayState>;  // name 'giveaway', version kernels.versionStamp()
  export const TRANSITIONS: Record<GiveawayStatus, readonly GiveawayStatus[]>;  // erlaubte Ziele je Zustand (§7.1), ohne drawn (nur über giveaway_drawn)
  // events.ts
  export function registerGiveawayEvents(registry: EventTypeRegistry, kernels: KernelRegistry): void;
  ```
- Ereignistypen (alle v1, Payload-Schemata mit zod):
  | Typ | Payload | Umkehr |
  |---|---|---|
  | `giveaway_created` | `{ teamId: uuid, kernelId, kernelVersion: int≥1, settings: GiveawaySettings }` (prize 1–200 Zeichen, sponsor ≤200 oder null, channels uuid[] min 1, winnersCount 1–100, claimDays 1–90, gates `{id: GateId}`-Objekte) | `none`, why `'Einen Entwurf nimmst du nicht zurück. Brich das Giveaway ab.'` |
  | `giveaway_status_changed` | `{ from, to }` | `compensate`: `state.status !== to` → `reject('not_latest_transition', 'Nimm zuerst die späteren Übergänge zurück.')`, sonst `{ type, payload: { from: to, to: from } }` (F5) |
  | `giveaway_settings_changed` | `{ before: GiveawaySettings, after: GiveawaySettings }` | `compensate`: `JSON.stringify(state.settings) !== JSON.stringify(after)` → `not_latest_transition`, sonst `{ before: after, after: before }` |
  | `participant_registered` | `{ pid: uuid }` | `compensate` → `participant_withdrawn {pid}` |
  | `participant_withdrawn` | `{ pid: uuid }` | `compensate` → `participant_registered {pid}` nur wenn `state.status === 'open'`, sonst `reject('not_open', 'Das Giveaway nimmt gerade keine Anmeldungen an.')` |
  | `giveaway_drawn` | `{ mode: DrawMode, winners: uuid[], pool: {pid, weight}[], poolHash: string, random: number[], gates: {pid, ok: boolean, reasons: string[]}[], excluded: uuid[] }` | `void` |
  | `winner_status_set` | `{ pid, from: WinnerStatus, to: WinnerStatus }` | `compensate`: `state.winners[pid] !== to` → `not_latest_transition`, sonst `{ pid, from: to, to: from }` |
  | je Kern | `kernel.events[*]`: Schema `z.any().superRefine` mit `def.check`, Umkehr aus `def.reversal` (compensate-inverse: `(target) => def.reversal.inverse(target.payload)` → `NewEvent` oder Rejection) | wie Kern |
  Dazu `registerRevertTypes(registry)` (event_voided).
- Reducer-Regeln:
  - `giveaway_created` → `exists`, Felder, `status 'draft'`, `kernelState = kernel.initialState(settings.config)`.
  - `giveaway_status_changed` → `status = to`.
  - `giveaway_settings_changed` → `settings = after`.
  - `participant_registered` → `registered[pid] = { since: at }`, `participant_withdrawn` → löschen.
  - `giveaway_drawn` → `draws.push({ eventId: e.id, winners, voided: false })`, `status 'drawn'`, `winners[pid] = 'pending'` für jeden neuen Gewinner (vorhandene Stati bleiben).
  - `event_voided` mit `reversesEventId` = `eventId` einer Ziehung → `voided = true`, `winners` neu aus gültigen Ziehungen (Stati behalten), `status = 'closed'`, wenn keine gültige Ziehung mehr. Andere `event_voided` → unverändert.
  - `winner_status_set` → `winners[pid] = to`.
  - Kern: für Typen in `kernel.events` und `participant_registered/withdrawn` → `kernelState = kernel.reduce(kernelState, toKernelEvent(e), settings.config)` (F7).
  - `TRANSITIONS`: `draft: ['open','cancelled']`, `open: ['paused','closed','cancelled']`, `paused: ['open','closed','cancelled']`, `closed: ['open','cancelled']`, `drawn: ['completed','cancelled']`, `completed: []`, `cancelled: []`.

- [ ] **Step 1: Failing tests** – `test/giveaway-state.test.ts` mit Helfer `rec(seq, type, payload, over?)` → `EventRecord` (ids `String(seq)`), `reduce(events)`:
  - `created sets draft and kernel initial state`.
  - `lifecycle follows status_changed` (draft→open→paused→open→closed).
  - `drawn then voided falls back to closed and clears winners`: drawn(winners [P1]) → `status 'drawn'`, `winners {P1:'pending'}`; `event_voided(reversesEventId '3')` → `status 'closed'`, `winners {}`, `draws[0].voided true`.
  - `replacement draw keeps winner statuses of kept winners`: drawn [P1,P2], status_set P1 done, voided, drawn [P1,P3] → winners `{P1:'done', P3:'pending'}`.
  - `kernel sees registration and own events only`: `participant_registered` P1 → `kernelState.registered [P1]`, `giveaway_status_changed` ändert `kernelState` nicht (Referenzgleichheit), `instant_window_opened` → `window` gesetzt.
  - `registerGiveawayEvents`: Registry akzeptiert `giveaway_drawn` mit gültiger Payload, lehnt `participant_registered {login:'x'}` ab (`identity_in_payload`), kennt `instant_window_opened` und `event_voided`, `instant_window_opened {until:'kein datum'}` → `invalid_payload`.
  - `status_changed inverse only for the latest transition`: `registry.get(statusChanged).reversal.inverse(target{from:'open',to:'paused'}, state{status:'open'})` → Rejection `not_latest_transition`, mit `status:'paused'` → `{ from: 'paused', to: 'open' }`.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren**.
- [ ] **Step 4: Prüfen** – `npm run typecheck && npx vitest run test/giveaway-state.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(giveaway): Zustand, Reducer und Ereignistypen des Giveaway-Stroms`

---

### Task 7: Lebenszyklus-Befehle, Lesetabelle `giveaways`, Runtime

**Files:**
- Create: `migrations/003_giveaways.sql` (vollständige DDL steht in Task 11, hier komplett anlegen), `src/framework/giveaway/authorize.ts`, `src/framework/giveaway/lifecycle.ts`, `src/framework/giveaway/projectors.ts` (nur `giveawaysProjector`), `src/framework/runtime.ts`, `test/helpers/giveaway.ts`
- Test: `test/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CommandHandler` neu, `StateProjector`), Task 5, Task 6, `makeRevertHandler`.
- Produces:
  ```ts
  // authorize.ts
  export interface GiveawayAuthorizer { controls(c: pg.PoolClient, actor: Actor, teamId: string): Promise<Rejection | null> }
  export const allowAll: GiveawayAuthorizer;
  export const denyUsers: GiveawayAuthorizer;   // system:* → null, sonst reject('no_accounts', 'Konten gibt es noch nicht. Dieser Befehl ist erst ab Teilprojekt 3 möglich.')
  export interface GiveawayRow { id: string; teamId: string; kernel: string; status: GiveawayStatus }
  export async function loadGiveawayRow(c: pg.PoolClient, giveawayId: string): Promise<GiveawayRow | null>;   // liest Lesetabelle `giveaways`
  export function authorizeControl(auth: GiveawayAuthorizer): (cmd: { giveawayId: string }, ctx: CommandContext, c: pg.PoolClient) => Promise<Rejection | null>;
  // → Zeile fehlt: reject('giveaway_not_found', 'Dieses Giveaway gibt es nicht.'), sonst auth.controls(c, ctx.actor, row.teamId)
  // projectors.ts (Task 7: nur dieser, Task 11 ergänzt die anderen)
  export function giveawaysProjector(kernels: KernelRegistry): StateProjector<GiveawayState>;   // name 'giveaways', Upsert aller Spalten aus dem Zustand (Spaltenregeln in Task 11)
  // runtime.ts (Task 7: Handler dieses Tasks + revert; Task 8–10 tragen ihre Handler nach, Task 11 die Projektoren)
  export interface RuntimeOptions { pool: pg.Pool; publisher: Publisher; auth: GiveawayAuthorizer; gates?: GateChecker; rng?: Rng; log: BusLogger; kernels?: KernelRegistry; snapshotEvery?: number }
  export interface Runtime {
    kernels: KernelRegistry; registry: EventTypeRegistry; projections: ProjectionRegistry; bus: CommandBus; reducer: StreamReducer<GiveawayState>;
    handlers: { create; open; pause; resume; close; reopen; cancel; complete; changeSettings; revert /* ab Task 8: register, withdraw; Task 9: kernelCommand; Task 10: draw, redraw, setWinnerStatus */ };
  }
  export function createRuntime(o: RuntimeOptions): Runtime;   // kernels ?? defaultKernels(), registerGiveawayEvents, registerState(giveawaysProjector), makeGiveawayReducer, CommandBus
  // lifecycle.ts
  export interface GiveawayDeps { kernels: KernelRegistry; auth: GiveawayAuthorizer; reducer: StreamReducer<GiveawayState> }
  export interface CreateGiveawayCmd { giveawayId: string; teamId: string; kernelId: string; settings: Partial<GiveawaySettings> & { prize: string; channels: Pid[] } }
  export interface GiveawayCmd { giveawayId: string }
  export interface ChangeSettingsCmd { giveawayId: string; settings: Partial<GiveawaySettings> }
  export function createGiveawayHandler(d: GiveawayDeps): CommandHandler<CreateGiveawayCmd, GiveawayState>;   // type 'create_giveaway'
  export function transitionHandler(d: GiveawayDeps, type: 'open_giveaway'|'pause_giveaway'|'resume_giveaway'|'close_giveaway'|'reopen_giveaway'|'cancel_giveaway'|'complete_giveaway'): CommandHandler<GiveawayCmd, GiveawayState>;
  export function changeSettingsHandler(d: GiveawayDeps): CommandHandler<ChangeSettingsCmd, GiveawayState>;  // type 'change_settings'
  export function giveawayRevertHandler(d: GiveawayDeps, registry: EventTypeRegistry): CommandHandler<RevertCommand, GiveawayState, RevertPrepared>;  // makeRevertHandler + authorizeControl über cmd.stream → giveawayId
  ```
- Regeln:
  - `create_giveaway`: authorize = `auth.controls(c, actor, cmd.teamId)` (keine Zeile nötig). decide: `state.exists` → `reject('already_exists', 'Dieses Giveaway gibt es schon.')`; Kern unbekannt → `reject('unknown_kernel', …)`; `validateConfig(kernel.configSchema, settings.config ?? {})` → Ablehnung durchreichen; `prize` leer → `reject('prize_required', 'Gib an, was es zu gewinnen gibt.')`; `channels` leer → `reject('channels_required', 'Wähle mindestens einen Kanal.')`; `winnersCount` außerhalb 1–100 → `reject('invalid_winners_count', 'Die Gewinnerzahl muss zwischen 1 und 100 liegen.')`; `claimDays` außerhalb 1–90 → `reject('invalid_claim_days', 'Die Meldefrist muss zwischen 1 und 90 Tagen liegen.')`; `gates` mit id außerhalb `supportedGates` → `reject('gate_unsupported', 'Die Bedingung <id> gibt es für diesen Kern nicht.')`; Defaults `sponsor null`, `winnersCount 1`, `claimDays 14`, `gates []`. Ereignis `giveaway_created` mit `kernelVersion = kernel.version`.
  - Übergänge (Ziel je Typ): open→`open` (aus draft **oder** closed = reopen; `reopen_giveaway` nur aus `closed`, `open_giveaway` nur aus `draft`), pause→`paused`, resume→`open` (aus paused), close→`closed` (aus open|paused), cancel→`cancelled` (aus allem außer completed/cancelled), complete→`completed` (aus drawn, nur wenn jeder Gewinner `done|forfeited`, sonst `reject('winners_open', 'Setze jeden Gewinn auf erledigt oder verfallen, bevor du abschließt.')`). Nicht erlaubt → `reject('invalid_transition', 'Aus dem Zustand <from> geht <Aktion> nicht.')`. Giveaway fehlt (`!state.exists`) → `giveaway_not_found`.
  - `change_settings`: nur `draft|open|paused` (sonst `reject('settings_locked', 'Nach dem Schließen änderst du keine Regeln mehr.')`), `config` erneut validieren, gleiche Prüfungen wie create, `after` = `before` überschrieben mit den gegebenen Feldern, unverändert → `[]`.
  - Revert: `authorizeControl` über `giveawayId` aus `cmd.stream` (`giveaway:` abschneiden).
- `test/helpers/giveaway.ts`:
  ```ts
  export const TEAM = '55555555-5555-4555-8555-555555555555'; export const GID = '66666666-6666-4666-8666-666666666666'; export const GID2 = '66666666-6666-4666-8666-666666666667';
  export const P1 = '77777777-7777-4777-8777-777777777777', P2 = '88888888-8888-4888-8888-888888888888', P3 = '99999999-9999-4999-8999-999999999999';
  export const STREAMER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  export const userOf = (pid: Pid) => `user:${pid}`;
  export async function setupGiveaway(over?: Partial<Omit<RuntimeOptions, 'pool' | 'publisher' | 'log'>> & { publisher?: Publisher }): Promise<{ pool: pg.Pool; rt: Runtime; publisher: InMemoryPublisher | Publisher; close(): Promise<void> }>;
  // freshDb + createRuntime({ auth: allowAll, publisher: new InMemoryPublisher(), log: { error: vi.fn() }, ...over })
  export async function run<C, S, P>(rt: Runtime, h: CommandHandler<C, S, P>, cmd: C, over?: Partial<CommandContext>): Promise<CommandResult>;  // rt.bus.execute(h, cmd, ctx({ actor: STREAMER, ...over }))
  export async function must<C, S, P>(rt: Runtime, h: CommandHandler<C, S, P>, cmd: C, over?: Partial<CommandContext>): Promise<EventRecord[]>;  // wie run, wirft bei Ablehnung mit code + message
  export async function createOpen(rt: Runtime, over?: Partial<CreateGiveawayCmd>): Promise<void>;   // must(create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] }, ...over }) + must(open, { giveawayId })
  export async function state(rt: Runtime, giveawayId?: string): Promise<GiveawayState>;             // Client aus rt.bus-Pool holen, loadStreamState, freigeben
  export const at = (offsetSec: number) => new Date(AT.getTime() + offsetSec * 1000);
  ```

- [ ] **Step 1: Failing tests** – `test/lifecycle.test.ts`:
  - `create writes giveaway_created with defaults and projects the row`: `settings: { prize: 'Key', channels: [P1] }` → Ereignis mit `winnersCount 1`, `claimDays 14`, `sponsor null`, `gates []`, `config { windowSec: 120 }`, Zeile in `giveaways` mit `status 'draft'`, `team_id TEAM`, `kernel 'instant'`, `kernel_version 1`, `claim_days 14`.
  - `create rejects: duplicate, unknown kernel, bad config, no prize, no channel, bad counts, unsupported gate` → Codes `already_exists`, `unknown_kernel`, `invalid_config`, `prize_required`, `channels_required`, `invalid_winners_count` (0), `invalid_claim_days` (91), `gate_unsupported` (`presence`), Journal hat nur das erste Ereignis.
  - `transitions follow the table`: draft→open→paused→open→closed→open(reopen)→closed; `pause` aus `closed` → `invalid_transition`; `resume` aus `open` → `invalid_transition`; `reopen` aus `draft` → `invalid_transition`; `complete` aus `closed` → `invalid_transition`.
  - `cancel works from draft, open, paused and closed`: vier Giveaways (ids GID, GID2 und zwei weitere) je in einem der Zustände → `cancel` ok, Status `cancelled`, danach `open` → `invalid_transition`. Der Fall „nach `completed` nicht“ steht in Task 10 (`winner status and complete`).
  - `change_settings only before closing and is reversible`: open → `change_settings { settings: { winnersCount: 2 } }` → Ereignis `before.winnersCount 1`, `after.winnersCount 2`; unverändertes `change_settings` → `ok`, keine Ereignisse; `close` → `change_settings` → `settings_locked`; revert des settings-Ereignisses (Zustand ist noch `after`, Umkehr ist erlaubt) → `winnersCount 1`; zweite Umkehr desselben Ereignisses → `already_reverted`.
  - `revert of the latest transition only`: open→paused→closed; revert(open→paused) → `not_latest_transition`; revert(paused→closed) → ok, Status `paused`.
  - `authorizer denies users, allows system`: `setupGiveaway({ auth: denyUsers })`, create als `STREAMER` → `no_accounts`, keine `stream_heads`-Zeile; als `system:scheduler` → ok.
  - `unknown giveaway is rejected before locking`: `open_giveaway` auf unbekannter id → `giveaway_not_found`, `stream_heads` leer.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren** – Migration 003 (DDL aus Task 11), `giveawaysProjector`, `authorize.ts`, `lifecycle.ts`, `runtime.ts`, Helfer.
- [ ] **Step 4: Prüfen** – `npm run typecheck && npm run lint && npx vitest run test/lifecycle.test.ts test/migrate.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(giveaway): Lebenszyklus-Befehle, Rechte-Schnittstelle, Lesetabelle giveaways, Runtime`

---

### Task 8: Anmeldung und Rückzug

**Files:**
- Create: `src/framework/giveaway/registration.ts`, `test/helpers/plain-kernel.ts`
- Modify: `src/framework/runtime.ts` (Handler `register`, `withdraw` eintragen)
- Test: `test/registration.test.ts`

**Interfaces:**
- Consumes: Task 5–7.
- Produces:
  ```ts
  export interface RegisterCmd { giveawayId: string; pid: Pid }
  export function registerHandler(d: GiveawayDeps): CommandHandler<RegisterCmd, GiveawayState>;   // type 'register'
  export function withdrawHandler(d: GiveawayDeps): CommandHandler<RegisterCmd, GiveawayState>;   // type 'withdraw'
  // test/helpers/plain-kernel.ts
  export const plainKernel: Kernel<Record<string, never>, { registered: Pid[] }>;  // id 'plain', keine events/commands, kein gateRegistration, pool = alle Angemeldeten mit Gewicht 1, drawMode 'equal'
  export function kernelsWithPlain(): KernelRegistry;   // defaultKernels() + plainKernel
  ```
- Tests dieses Tasks nutzen `setupGiveaway({ kernels: kernelsWithPlain() })` und `createOpen(rt, { kernelId: 'plain', settings: { prize: 'Key', channels: [P1], config: {} } })`, damit Anmeldung ohne Kern-B-Fenster prüfbar ist. Das Fenster-Gate von Kern B testet Task 9.
- Regeln: authorize = `ctx.actor === userOf(pid)` oder `ctx.actor.startsWith('system:')`, sonst `reject('not_you', 'Du kannst nur dich selbst anmelden oder abmelden.')`. Dazu `loadGiveawayRow` → `giveaway_not_found`.
  `register` decide: `status !== 'open'` → `reject('not_open', 'Das Giveaway nimmt gerade keine Anmeldungen an.')`; schon angemeldet → `reject('already_registered', 'Du bist schon angemeldet.')`; `kernel.gateRegistration?.(kernelState, config, now.toISOString())` → durchreichen; sonst `participant_registered {pid}`.
  `withdraw` decide: nicht angemeldet → `reject('not_registered', 'Du bist nicht angemeldet.')`; `status in drawn|completed|cancelled` → `reject('too_late', 'Nach der Ziehung ist kein Rückzug mehr möglich.')`; sonst `participant_withdrawn {pid}` (auch in `paused`/`closed`, §6.4 „bis zur Ziehung“).

- [ ] **Step 1: Failing tests** – `test/registration.test.ts` (Kern `plain`):
  - `register writes participant_registered and the kernel sees it`: `state(rt)` → `registered[P1].since === AT.toISOString()`, `kernelState.registered [P1]`.
  - `register rejects when not open, twice, as someone else`: draft → `not_open`; paused → `not_open`; zweimal → `already_registered`; Akteur `userOf(P2)` für `pid P1` → `not_you`, kein Ereignis.
  - `withdraw works until drawn, reversal re-registers only while open`: open: register P1, pause, withdraw → ok (in paused); revert(withdrawn) in paused → `not_open`; resume, revert → ok, P1 wieder angemeldet.
  - `parallel register of same pid yields one event`: 10× gleichzeitig `register P1` → genau eine `ok`, neun `already_registered`, Journal hat genau ein `participant_registered`.
  - `system actor may register on behalf (simulator path)`: Akteur `system:ingest` → ok.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren**.
- [ ] **Step 4: Prüfen** – `npx vitest run test/registration.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(giveaway): Anmeldung und Rückzug über den Rahmen`

---

### Task 9: Kern-Befehle (`decide`) und Kern-B-Fenster im Rahmen

**Files:**
- Create: `src/framework/giveaway/kernel-command.ts`
- Modify: `src/framework/runtime.ts` (Handler `kernelCommand`), `test/helpers/giveaway.ts` (`openWindow(rt, over?)` = `must(rt, rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } }, over)`)
- Test: `test/kernel-command.test.ts`

**Interfaces:**
- Consumes: Task 5–8.
- Produces:
  ```ts
  export interface KernelCommandCmd { giveawayId: string; command: KernelCommand }
  export function kernelCommandHandler(d: GiveawayDeps): CommandHandler<KernelCommandCmd, GiveawayState>;   // type 'kernel_command'
  ```
- Regeln: authorize: Zeile laden (→ `giveaway_not_found`), Kern aus Zeile, `spec = kernel.commands.find(type)` fehlt → `reject('unknown_command', 'Diesen Befehl kennt der Kern <label> nicht.')`. `issuer 'participant'` → Akteur muss `userOf(command.pid)` sein (`not_you`); `'streamer'` → `auth.controls`; `'scheduler'` → Akteur `system:scheduler` **oder** `auth.controls` ok. decide: `status !== 'open'` → `reject('not_open', 'Kern-Befehle gehen nur, solange das Giveaway offen ist.')`; `kernel.decide` fehlt → `unknown_command`; Ergebnis des Kerns: Rejection durchreichen, Ereignisse 1:1 als `NewEvent` (Typ muss mit `${kernel.id}_` beginnen, sonst `throw new Error('Der Kern <id> hat ein fremdes Ereignis erzeugt: <type>')` – Programmierfehler, kein Reject).

- [ ] **Step 1: Failing tests** – `test/kernel-command.test.ts` (Kern B):
  - `open_window writes instant_window_opened with until from config`: `until = AT + 120 s`, Zustand `kernelState.window.until`.
  - `open_window twice is rejected by the kernel`: `window_open`.
  - `registration follows the window`: ohne Fenster `register P1` → `window_closed`; Fenster öffnen → ok.
  - `rejects registration after until even if window not yet closed`: Fenster offen, `register` mit `ctx({ now: at(120) })` → `window_closed`, mit `at(119)` → ok.
  - `close_window by scheduler is idempotent`: Akteur `system:scheduler` → ein `instant_window_closed`, zweiter Aufruf → `ok: true, events: []`.
  - `issuer rules are enforced through the authorizer`: `setupGiveaway({ auth: denyUsers })`, Giveaway als `system:scheduler` anlegen und öffnen; `open_window` als `userOf(P1)` → `no_accounts`; `open_window` als `system:scheduler` → ok (`denyUsers` lässt `system:*` durch); `close_window` als `system:scheduler` → ok. Mit `allowAll`: Kern-Befehl `{ type: 'buy', pid: P1, args: {} }` eines nicht deklarierten Typs → `unknown_command`.
  - `kernel commands only while open`: pause → `open_window` → `not_open`.
  - `participants accumulate across two windows`: Fenster 1: P1 anmelden, schließen, Fenster 2: P2 anmelden → `kernel.pool` 2 Einträge.
  - `window_opened can be reverted into window_closed`: revert des `instant_window_opened` mit Grund → Ereignis `instant_window_closed` mit `reversesEventId`, Zustand `window null`.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren**.
- [ ] **Step 4: Prüfen** – `npx vitest run test/kernel-command.test.ts test/registration.test.ts` → grün.
- [ ] **Step 5: Commit** – `feat(giveaway): Kern-Befehle über decide, Anmeldefenster von Kern B`

---

### Task 10: Ziehung, Ersatzziehung, Gewinnerstatus

**Files:**
- Create: `src/framework/giveaway/draw.ts`
- Modify: `src/framework/runtime.ts` (Handler `draw`, `redraw`, `setWinnerStatus`; `gates ?? noGates`, `rng ?? csprng`)
- Test: `test/draw.test.ts` (rein, ohne DB), `test/draw-command.test.ts`

**Interfaces:**
- Consumes: Task 5–7, `node:crypto`.
- Produces:
  ```ts
  export type Rng = () => number;                               // in [0, 1)
  export const csprng: Rng;                                    // randomInt(0, 2**48) / 2**48
  export function rngFrom(values: number[]): Rng;               // Wiedergabe für Reproduktion, wirft bei Erschöpfung
  export function poolHash(pool: PoolEntry[]): string;          // sha256 über JSON der nach pid sortierten Liste, hex
  export function drawWinners(pool: PoolEntry[], mode: DrawMode, count: number, rng: Rng): { winners: Pid[]; random: number[] };
  export interface GateResult { pid: Pid; ok: boolean; reasons: string[] }
  export interface GateChecker { check(c: pg.PoolClient, gates: GateConfig[], pids: Pid[]): Promise<GateResult[]> }
  export const noGates: GateChecker;                           // alle ok, reasons []
  export interface DrawDeps extends GiveawayDeps { gates: GateChecker; rng: Rng }
  export interface DrawCmd { giveawayId: string }
  export interface RedrawCmd { giveawayId: string; replace: Pid; reason: string }
  export interface WinnerStatusCmd { giveawayId: string; pid: Pid; status: WinnerStatus }
  export function drawHandler(d: DrawDeps): CommandHandler<DrawCmd, GiveawayState, GateResult[]>;          // type 'draw'
  export function redrawHandler(d: DrawDeps): CommandHandler<RedrawCmd, GiveawayState, GateResult[]>;      // type 'redraw'
  export function winnerStatusHandler(d: GiveawayDeps): CommandHandler<WinnerStatusCmd, GiveawayState>;    // type 'set_winner_status'
  ```
- `drawWinners`: Einträge mit `weight <= 0` oder nicht-endlich raus. `count = min(count, n)`. `weighted`/`equal` (equal setzt alle Gewichte 1): ohne Zurücklegen, je Zug `r = rng()`, Ziel `r * Σweight`, kumulativ laufen, Treffer entfernen, `random.push(r)`. `highest`: nach Gewicht absteigend; Einträge über der Schnittkante sicher, Gleichstand an der Kante per `rng` ohne Zurücklegen (nur dafür `random`-Einträge). Deterministisch: gleicher Topf (beliebige Reihenfolge) + gleiche `random` → gleiche Gewinner (intern nach `pid` sortieren).
- `draw` decide: `!exists` → `giveaway_not_found`; `status !== 'closed'` → `reject('not_closed', 'Schließe das Giveaway, bevor du ziehst.')`; `pool = kernel.pool(kernelState, config)`; `prepare` liefert `gates.check(c, settings.gates, pool.map(pid))`; Topf = Einträge mit `ok`; leer → `reject('empty_pool', kernel.display.emptyPool)`; Ereignis `giveaway_drawn { mode: kernel.drawMode, winners, pool (gefiltert), poolHash, random, gates, excluded: [] }`.
- `redraw` decide: `status !== 'drawn'` → `reject('not_drawn', 'Es gibt keine gültige Ziehung, die du ersetzen könntest.')`; `reason` leer → `reason_required`; `replace` kein aktueller Gewinner → `reject('not_a_winner', 'Diese Person ist kein Gewinner.')`; Topf ohne alle aktuellen Gewinner und ohne `replace`; leer → `empty_pool` (nichts geschrieben); sonst **zwei** Ereignisse: `event_voided { targetType: 'giveaway_drawn' }` mit `reason`, `reversesEventId = aktive Ziehung` (bei mehreren aktiven: die mit `replace`) und `giveaway_drawn` mit `winners = [behaltene…, neuer]`, `excluded = [replace, …vorherige Ausschlüsse]`, `random` nur für den neuen Zug.
- `set_winner_status`: `status !== 'drawn'` → `reject('not_drawn', …)`; pid kein Gewinner → `not_a_winner`; gleich → `[]`; sonst `winner_status_set { pid, from, to }`. Erlaubte Werte: `reported|shipped|done|forfeited`.
- Revert (`giveawayRevertHandler`) einer `giveaway_drawn` → `event_voided` (bestehender Mechanismus), Reducer setzt `closed`.

- [ ] **Step 1: Failing tests (rein)** – `test/draw.test.ts`:
  - `poolHash is order independent and sensitive to weight`.
  - `weighted draw is reproducible from random`: Topf 5 Einträge, `csprng` ziehen (count 2) → `random` Länge 2, `drawWinners(shuffled pool, 'weighted', 2, rngFrom(random))` gleiche Gewinner.
  - `equal ignores weights`: Gewichte 1 und 1000, `rngFrom([0.6])` → der Eintrag an Position ⌈0.6·n⌉ (nach pid sortiert), nicht der schwere.
  - `weighted respects weights`: 10.000 Züge mit `csprng`, Gewichte 1:3 → Anteil des schweren in `[0.70, 0.80]`.
  - `highest picks top and breaks ties randomly`: Gewichte 5,5,3 count 1 → Gewinner ∈ {a,b}, `random` Länge 1; Gewichte 5,3 → `a`, `random` Länge 0.
  - `drops zero and negative weights, caps count`: Topf [0, -1, 2] count 3 → genau ein Gewinner.
  - `rngFrom throws when exhausted`.
- [ ] **Step 2: Failing tests (Bus)** – `test/draw-command.test.ts` (Kern B, `setupGiveaway({ rng: rngFrom([...]) })`, Teilnehmer P1–P3 anmelden, schließen):
  - `draw needs closed`: aus open → `not_closed`.
  - `draw writes the proof`: `giveaway_drawn` mit `mode 'equal'`, `pool` 3×weight 1, `poolHash === poolHash(pool)`, `gates` 3× ok, `random` Länge 1, Status `drawn`, `winners[w] 'pending'`.
  - `empty pool is explained`: niemand angemeldet → `empty_pool`, message `'Niemand hat sich im Anmeldefenster angemeldet.'`, kein Ereignis.
  - `redraw voids and redraws without the old winner in one command`: `redraw { replace: w, reason: 'Keine Meldung' }` → zwei Ereignisse (`event_voided`, `giveaway_drawn`), neuer Gewinner ≠ w, `excluded [w]`, `draws[0].voided true`, Status `drawn`.
  - `redraw with nobody else leaves the old draw valid`: nur P1 angemeldet, draw, redraw → `empty_pool`, Journal unverändert, Status `drawn`, `draws[0].voided false`.
  - `revert of a draw falls back to closed and reopen is possible`: revert(drawn, reason) → `event_voided`, Status `closed`, `reopen_giveaway` → ok.
  - `winners_count 2 draws two distinct winners`: `change_settings { winnersCount: 2 }` vor close → 2 verschiedene Gewinner, `random` Länge 2.
  - `winner status and complete`: `set_winner_status P done` → Ereignis; `complete` mit zweitem Gewinner `pending` → `winners_open`; zweiter `forfeited` → `complete` ok → `completed`; `cancel` → `invalid_transition`; `set_winner_status` nach `completed` → `not_drawn`.
  - `set_winner_status rejects non-winner and non-drawn`.
- [ ] **Step 3: Laufen lassen** → FAIL.
- [ ] **Step 4: Implementieren**.
- [ ] **Step 5: Prüfen** – `npm run typecheck && npm run lint && npx vitest run test/draw.test.ts test/draw-command.test.ts test/lifecycle.test.ts` → grün.
- [ ] **Step 6: Commit** – `feat(giveaway): Ziehung mit Nachweis, Ersatzziehung, Gewinnerstatus`

---

### Task 11: Lesetabellen Teilnehmer und Zeitgeber, Kern-Versionsabgleich

**Files:**
- Modify: `src/framework/giveaway/projectors.ts` (zwei Projektoren + `reconcileKernelVersions` ergänzen), `src/framework/runtime.ts` (beide registrieren)
- Test: `test/giveaway-projections.test.ts`
- Migration `003_giveaways.sql` ist seit Task 7 vollständig (DDL unten). Keine 004: TP2 ist nirgends deployt.

**Interfaces:**
- Consumes: Task 2 (`StateProjector`, `rebuildStream`), Task 5–10.
- Produces:
  ```ts
  // projectors.ts (ergänzt)
  export function participantsProjector(kernels: KernelRegistry): StateProjector<GiveawayState>;     // name 'giveaway_participants'
  export function timersProjector(kernels: KernelRegistry): StateProjector<GiveawayState>;           // name 'timers'
  export const RUNNING: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed'];
  /** Giveaways in RUNNING mit abweichender kernel_version → rebuildStream. Liefert die neu aufgebauten ids. */
  export async function reconcileKernelVersions(pool: pg.Pool, rt: Runtime): Promise<string[]>;
  ```
- Migration `003_giveaways.sql` (Task 7 legt sie so an):
  ```sql
  CREATE TABLE giveaways (
    id UUID PRIMARY KEY, team_id UUID NOT NULL, kernel TEXT NOT NULL, kernel_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','open','paused','closed','drawn','completed','cancelled')),
    prize TEXT NOT NULL, sponsor TEXT, winners_count INTEGER NOT NULL, claim_days INTEGER NOT NULL, config JSONB NOT NULL, channels JSONB NOT NULL, gates JSONB NOT NULL,
    registered_count INTEGER NOT NULL DEFAULT 0, pool_size INTEGER NOT NULL DEFAULT 0, pool_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX giveaways_team_status ON giveaways (team_id, status);
  CREATE TABLE giveaway_participants (
    giveaway_id UUID NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE, pid UUID NOT NULL,
    registered BOOLEAN NOT NULL, in_pool BOOLEAN NOT NULL, weight DOUBLE PRECISION NOT NULL, winner_status TEXT,
    PRIMARY KEY (giveaway_id, pid)
  );
  CREATE TABLE timers (
    stream TEXT NOT NULL, key TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL, command JSONB NOT NULL,
    PRIMARY KEY (stream, key)
  );
  CREATE INDEX timers_due ON timers (due_at);
  ```
- Regeln: `giveawaysProjector.apply` (aus Task 7) = Upsert aus Zustand (`kernel_version = kernels.get(kernelId).version`, `registered_count`, `pool_size`/`pool_weight` aus `kernel.pool`, `claim_days = settings.claimDays`, `created_at` nur beim Insert = `head.at`, `updated_at = head.at`, `last_seq = head.seq`). `participantsProjector.apply`: Zielmenge = angemeldete ∪ Topf-pids; `DELETE … WHERE giveaway_id = $1 AND pid <> ALL($2)`, dann Upsert je pid (`registered`, `in_pool`, `weight`, `winner_status = state.winners[pid] ?? null`). `timersProjector.apply`: Soll = `status === 'open' ? kernel.timers?.(…) ?? [] : []`; `DELETE` nicht enthaltene Keys, Upsert Rest (`due_at`, `command`). `reset(c, stream?)`: `DELETE` je Tabelle, mit `stream` nur die Zeilen des Giveaways. `Chance` wird nicht gespeichert (Gewicht ÷ `pool_weight` beim Lesen).
- `createRuntime` registriert jetzt alle drei StateProjectors.

- [ ] **Step 1: Failing tests** – `test/giveaway-projections.test.ts`:
  - `giveaways row mirrors the state`: create → `status draft`, `registered_count 0`; open, Fenster, P1+P2 anmelden → `registered_count 2`, `pool_size 2`, `pool_weight 2`, `last_seq` = letzte seq.
  - `participants rows follow registration, pool and winner status`: nach Anmeldung zwei Zeilen `registered true, in_pool true, weight 1`; withdraw P2 → eine Zeile; close, draw → `winner_status 'pending'` beim Gewinner; `set_winner_status done` → `'done'`.
  - `timers mirror open windows only`: Fenster öffnen → Zeile `(giveaway:<GID>, 'window_end', until, {type:'close_window', args:{}})`; pause → keine Zeile; resume → wieder eine (Fenster stand noch im Zustand); close_window → keine.
  - `rebuildStream reproduces the rows`: alle drei Tabellen für GID mit `UPDATE`/`DELETE` kaputt machen (Zweit-Giveaway unverändert lassen) → `projections.rebuildStream(pool, registry, giveawayStream(GID), reducer)` → Zeilen wie vorher, Zweit-Giveaway unberührt.
  - `reconcile rebuilds open giveaways only`: zwei Giveaways (eines offen, eines `completed`), `UPDATE giveaways SET kernel_version = 99, registered_count = 42` für beide → `reconcileKernelVersions` liefert `[GID_open]`, offenes hat wieder `kernel_version 1, registered_count` korrekt, `completed` behält 99/42.
  - `kernel version change invalidates snapshots`: `setupGiveaway({ snapshotEvery: 2 })`, 4 Ereignisse → Snapshot vorhanden mit `reducer_version = rt.reducer.version`; zweite Runtime (`createRuntime` auf demselben Pool) mit Registry, deren Kern B `version: 2` trägt (Kopie `{ ...instantKernel, version: 2 }`) → `state(rt2)` gleich dem Replay über `readStream` + `rt2.reducer`, und `loadSnapshot(pool, giveawayStream(GID), { name: 'giveaway', version: rt2.reducer.version })` ist `null`.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren** – Projektoren, `reconcileKernelVersions`, Runtime ergänzen.
- [ ] **Step 4: Prüfen** – `npm run typecheck && npm run lint && npx vitest run` (ganze Suite) → grün. Zahl der Dateien/Tests notieren.
- [ ] **Step 5: Commit** – `feat(giveaway): Lesetabellen Teilnehmer und Zeitgeber, Kern-Versionsabgleich`

---

### Task 12: Scheduler – eine Instanz, fällige Zeitgeber, Verdrahtung, Betrieb

**Files:**
- Create: `src/scheduler/lock.ts`, `src/scheduler/timers.ts`
- Modify: `src/scheduler/main.ts`, `src/app/main.ts`, `../../docker-compose.dev.yml`, `../../README.md`
- Test: `test/scheduler-timers.test.ts`, `test/scheduler-lock.test.ts`

**Interfaces:**
- Consumes: Task 11 (`Runtime`, `timers`), TP1 (`scheduleLoop`, `runMaintenance`, `createPool`).
- Produces:
  ```ts
  // lock.ts
  export const SCHEDULER_LOCK_KEY = 4242002;
  export class SchedulerLockError extends Error {}   // message 'Ein Scheduler läuft schon. Beende diesen Prozess, es darf nur einen geben.'
  /** Hält einen eigenen Client mit pg_try_advisory_lock bis release(). */
  export async function acquireSchedulerLock(pool: pg.Pool): Promise<{ release(): Promise<void> }>;
  // timers.ts
  export const TIMER_INTERVAL_MS = 5_000;
  export const TIMER_BATCH = 100;
  /** Fällige timers (due_at <= now, ORDER BY due_at, LIMIT batch) als kernel_command mit Akteur system:scheduler. Abgelehnte oder fehlende Ziele: Zeile löschen (Spiegel, kein Zustand) und zählen. Wirft ein Befehl, zählt `failed`, die Zeile bleibt, der Lauf geht weiter. */
  export async function runDueTimers(pool: pg.Pool, rt: Runtime, now: Date, log: BusLogger, batch = TIMER_BATCH): Promise<{ ran: number; rejected: number; failed: number }>;
  ```
- `scheduler/main.ts`: `acquireSchedulerLock` vor allem anderen (bei `SchedulerLockError` → Meldung, `exit(1)`), Migration über eigenen Pool mit `queryTimeoutMillis: 0` (dann `end()`), `createRuntime` mit `RedisPublisher(new Redis(config.redisUrl))`, `denyUsers`, Loop 1: `runMaintenance` stündlich (bestehend), Loop 2: `runDueTimers` alle 5 s. Shutdown stoppt beide Loops, gibt Lock frei, schließt Redis und Pool.
- `app/main.ts`: Migration über eigenen Pool mit `queryTimeoutMillis: 0`, `createRuntime` (Publisher Redis, `denyUsers`), `reconcileKernelVersions` nach `ensurePartitions`, Ergebnis loggen. Keine neuen Routen.
- `docker-compose.dev.yml`: `postgres.healthcheck` (`pg_isready -U ccg`, interval 5 s, retries 10), `stop_grace_period: 30s` für beide Dienste.
- README: Abschnitt „Prozesse“ ergänzen (Scheduler-Lock, Zeitgeber alle 5 s, Timer-Tabelle ist ein Spiegel).

- [ ] **Step 1: Failing tests** – `test/scheduler-lock.test.ts`: zweiter `acquireSchedulerLock` auf derselben DB wirft `SchedulerLockError`, nach `release()` gelingt er. `test/scheduler-timers.test.ts`:
  - `closes an expired window via command`: Fenster öffnen (`until = AT+120`), `runDueTimers(pool, rt, at(119))` → `{ ran: 0 }`, Zeile bleibt; `runDueTimers(…, at(120))` → `{ ran: 1 }`, Journal hat `instant_window_closed` mit Akteur `system:scheduler`, `timers` leer.
  - `stale timer rows are removed when the command is rejected`: Zeile von Hand in `timers` für ein pausiertes Giveaway einfügen (Test darf die Spiegeltabelle direkt schreiben – sie ist kein Zustand) → `runDueTimers` → `{ rejected: 1 }`, Zeile weg, kein Ereignis.
  - `missing giveaway row removes the timer`: Zeile für unbekannte id → `rejected 1`.
  - `runs at most batch per call`: 3 Giveaways mit fälligen Fenstern, `runDueTimers(pool, rt, at(120), log, 2)` → `ran 2`, zweiter Aufruf → `ran 1`, dritter → `ran 0`.
- [ ] **Step 2: Laufen lassen** → FAIL.
- [ ] **Step 3: Implementieren** – `lock.ts`, `timers.ts`, beide `main.ts`, Compose, README.
- [ ] **Step 4: Prüfen** – `npm run typecheck && npm run lint && npx vitest run && npm run build` → grün, Build exit 0. Startprobe mit Dev-Compose (Betreiber startet Docker): `docker compose -f docker-compose.dev.yml up -d`, dann im `packages/server`: `set -a; . ../../.env; node dist/scheduler/main.js` → Log „Wartung erledigt“, zweite Instanz parallel → `Ein Scheduler läuft schon…`, exit 1. `node dist/app/main.js` → `curl localhost:3000/healthz` → `{"status":"ok"}`, Log nennt `reconcile` mit `[]`. Ausgaben im Ledger notieren (Windows: SIGTERM-Pfad bleibt wie in TP1 nicht prüfbar – sagen).
- [ ] **Step 5: Commit** – `feat(scheduler): Einzelinstanz-Lock, fällige Zeitgeber als Befehle, Verdrahtung von app und scheduler`

---

## Nach diesem Plan

- **TP3 (Konten):** `identities (pid, twitch_id, …)`, echte `GiveawayAuthorizer`-Implementierung über Team-Mitgliedschaft (TP7), Rechtstexte-Pflicht als Gate in `open_giveaway`, `participant_registered` bekommt `termsVersion` (v2 + Upcaster). HTTP-Routen mit Handler-Registry und Rejection→HTTP-Mapping.
- **TP4 (Ingest):** Gewinner-Ansage im Chat als Folge von `giveaway_drawn` (Outbox, Umkehrart `none`), Statusblock-Daten.
- **TP5:** `GateChecker` mit Helix, Zuschauzeit-Dienst. `participantsProjector` schreibt heute alle Zeilen je Befehl neu – bei `watch_credited` mit 200 Einträgen pro Minute inkrementell machen (Diff zum vorigen Zustand oder Ereignis-Projektor für Gewichte).
- **TP6 (Kern C):** `cancel_giveaway` braucht einen Kern-Hook für Erstattungen (heute kein Hook – bewusst, YAGNI).
- Offen aus TP1 bleibt: `DETACH/DROP PARTITION` nicht per Trigger blockierbar (DB-Rolle), `query_timeout` jetzt für Migration gelöst.
