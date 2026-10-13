# Teilprojekt 1 „Fundament“ – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein neues Repository mit CI, typisierter Konfiguration, Migrationen und einem PG-Ereignisjournal, in das Zustandsänderungen ausschließlich über einen Command-Bus gelangen – inklusive Umkehrung, Projektionen, Snapshots, Push und gedrosseltem Zugriffslog.

**Architecture:** Modularer Monolith in TypeScript. PostgreSQL ist die einzige Wahrheit: Tabelle `events` (append-only, monatlich partitioniert) plus `stream_heads` als Sperre je Strom. Ein Befehl läuft immer gleich: Rechte → Strom sperren → Zustand laden (Snapshot + Rest) → `decide` → Ereignisse anhängen → Projektionen in derselben Transaktion → Commit → Push über Redis. Noch keine Kerne, kein Twitch, keine UI – diese folgen in Teilprojekt 2–8.

**Tech Stack:** Node.js 24, TypeScript (NodeNext, strict), npm-Workspaces, Fastify, `pg`, `ioredis`, `zod`, Vitest, Testcontainers (PostgreSQL 17, Redis 7), ESLint + typescript-eslint, GitHub Actions.

**Spec:** `NEW_DESIGN.md` (nach Task 1: `C:\Users\streamer\Documents\Projekte\CC\CC-Giveaway-NG\NEW_DESIGN.md`). Pflicht: vor jeder Arbeit vollständig lesen. Relevant für diesen Plan: §3.2–3.4, §5, §12.1–12.4, §14 Punkt 1.

## Global Constraints

- Repository-Ort: `C:\Users\streamer\Documents\Projekte\CC\CC-Giveaway-NG` (Annahme, vom Betreiber vor Task 1 zu bestätigen).
- Node ≥ 24, `"type": "module"`, Imports mit `.js`-Endung (NodeNext).
- PostgreSQL 17, Redis 7. Redis hält nur abgeleiteten Zustand (§3.2).
- Jede Zustandsänderung läuft durch `CommandBus.execute` (§3.3). Kein zweiter Schreibweg.
- `events` ist append-only: kein UPDATE, kein DELETE, kein TRUNCATE – per Trigger erzwungen (§5.1).
- „Erster gewinnt“ entscheidet die Datenbank (`SELECT … FOR UPDATE` auf `stream_heads`), nie die JS-Reihenfolge (§5.1).
- Ereignis-Payloads enthalten nie Twitch-Name oder Twitch-ID, nur `pid` (§5.1).
- Umkehrarten exakt: `compensate`, `void`, `none` (§5.3). `reason` ist Pflicht bei Umkehrungen.
- Snapshot alle 1.000 Ereignisse eines Stroms (§5.4).
- Ablehnungen im `access_log` gedrosselt: höchstens ein Eintrag je (Akteur, Befehl, Grund) in 5 Minuten, mit Zähler (§5.5).
- IP-Adressen im `access_log` nach 30 Tagen entfernen (§12.4).
- Fehlt ein Pflichtwert in der Konfiguration, startet der Prozess nicht und nennt alle Fehler (§12.3).
- Ein Kern importiert nur `kernel-api` – per ESLint erzwungen (§3.4).
- Fehlertexte deutsch, kurz, aktiv: was passiert ist + was zu tun ist (§11.6).
- Tests brauchen Docker (Testcontainers). Kein Test nutzt eine fremde, laufende Datenbank.

## Review Focus

1. **Zwei Befehle gleichzeitig auf denselben Strom** (zwei App-Instanzen) → beide gelingen, `seq` lückenlos 1..n, keine Dublette. Test: Task 9 Step 1 (`parallel commands keep seq gapless`).
2. **Monatswechsel ohne vorher angelegte Partition** (erster Befehl am 1. um 00:00:05, Scheduler lief noch nicht) → Befehl gelingt trotzdem. Test: Task 9 Step 1 (`creates missing partition and retries`).
3. **Projektion wirft mitten im Befehl** → kein Ereignis, `stream_heads` unverändert, kein Push. Test: Task 9 Step 1 (`projection failure rolls back everything`).
4. **Doppelte Umkehrung / Umkehrung eines `none`-Ereignisses / Umkehrung aus fremdem Strom** → saubere Ablehnung mit Klartext, kein Ereignis. Test: Task 10 Step 1.
5. **Mehrere fehlende/kaputte ENV-Werte gleichzeitig** → Start bricht ab und listet alle, nicht nur den ersten. Test: Task 3 Step 1 (`lists every problem at once`).

---

## Dateistruktur (Ziel nach Task 11)

```
CC-Giveaway-NG/
├─ .github/workflows/ci.yml
├─ .gitattributes · .gitignore · .env.example · README.md · CLAUDE.md · NEW_DESIGN.md
├─ docker-compose.dev.yml
├─ package.json                         # npm-Workspaces
└─ packages/server/
   ├─ package.json · tsconfig.json · tsconfig.build.json · vitest.config.ts · eslint.config.js
   ├─ migrations/
   │  ├─ 001_journal.sql                # events (partitioniert), stream_heads, snapshots, Trigger
   │  └─ 002_access_log.sql
   ├─ src/
   │  ├─ config/config.ts               # zod-Schema, loadConfig, ConfigError
   │  ├─ db/pool.ts                     # createPool, withTx, Queryable
   │  ├─ db/migrate.ts                  # runMigrations
   │  ├─ shared/rejection.ts            # Rejection, reject, isRejection
   │  ├─ journal/types.ts               # StreamId, Actor, NewEvent, EventRecord, JournalError, Prüfer
   │  ├─ journal/guard.ts               # assertNoTwitchIdentity
   │  ├─ journal/event-types.ts         # EventTypeRegistry, ReversalSpec, Upcaster
   │  ├─ journal/partitions.ts          # partitionName, ensurePartitions
   │  ├─ journal/journal.ts             # lockStream, appendLocked, readStream, readEvent, isReverted, rowToRecord
   │  ├─ journal/snapshots.ts           # loadSnapshot, saveSnapshot
   │  ├─ audit/access-log.ts            # logDenied (gedrosselt), logRead, purgeIps
   │  ├─ framework/projections.ts       # Projector, ProjectionRegistry (applyAll, rebuild)
   │  ├─ framework/publisher.ts         # Publisher, InMemoryPublisher, RedisPublisher
   │  ├─ framework/command-bus.ts       # StreamReducer, CommandHandler, CommandBus
   │  ├─ framework/revert.ts            # registerRevertTypes, makeRevertHandler
   │  ├─ app/build-app.ts · app/main.ts # Fastify, /healthz
   │  └─ scheduler/maintenance.ts · scheduler/main.ts
   └─ test/
      ├─ global-setup.ts                # PG-Container für den ganzen Lauf
      ├─ helpers/db.ts                  # freshDb, AT
      ├─ helpers/fixtures.ts            # Test-Ereignistypen, Reducer, Handler
      └─ *.test.ts
```

---

### Task 1: Repository-Gerüst, CI, Spec-Umzug

**Files:**
- Create: `CC-Giveaway-NG/package.json`, `.gitignore`, `.gitattributes`, `README.md`, `CLAUDE.md`, `.github/workflows/ci.yml`
- Create: `packages/server/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `test/smoke.test.ts`
- Move: `CC-Giveaway/NEW_DESIGN.md` → `CC-Giveaway-NG/NEW_DESIGN.md`
- Modify: `CC-Giveaway/NEW_DESIGN.md` (wird Verweis), `CC-Giveaway/CLAUDE.md` (Pfad im Pflichtblock)

**Interfaces:**
- Consumes: nichts
- Produces: Root-Skripte `npm run typecheck|lint|test|build`; Workspace `@ccg/server`

- [ ] **Step 1: Ordner und Git anlegen**

```bash
mkdir -p "C:/Users/streamer/Documents/Projekte/CC/CC-Giveaway-NG/packages/server/test"
cd "C:/Users/streamer/Documents/Projekte/CC/CC-Giveaway-NG"
git init -b main
```

- [ ] **Step 2: Root-Dateien schreiben**

`package.json`:
```json
{
  "name": "cc-giveaway-ng",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
coverage/
```

`.gitattributes`:
```
* text=auto eol=lf
```

`README.md`:
```markdown
# CC-Giveaway NG

Neubau der Giveaway-Plattform. Das Design steht in [NEW_DESIGN.md](NEW_DESIGN.md).

## Entwickeln

1. Node 24 und Docker installieren.
2. `npm ci` ausführen.
3. `docker compose -f docker-compose.dev.yml up -d` startet PostgreSQL und Redis.
4. `.env.example` nach `.env` kopieren.
5. `npm test` startet alle Tests. Die Tests starten eigene Container.
```

`CLAUDE.md`:
```markdown
# CLAUDE.md

## PFLICHTLEKTÜRE
**[NEW_DESIGN.md](NEW_DESIGN.md) vor jeder Arbeit VOLLSTÄNDIG lesen – jede Zeile, kein Überfliegen,
kein Teil-Lesen per offset/limit oder grep.** Bei Widerspruch gilt NEW_DESIGN.md.

## Harte Regeln
- Jede Zustandsänderung läuft durch `CommandBus.execute`. Kein zweiter Schreibweg, auch nicht für Tests oder Simulator.
- `events` ist append-only. Korrektur = neues Ereignis. Nie UPDATE/DELETE auf `events`.
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity`).
- Ein Kern (`src/kernels/*`) importiert nur `src/kernel-api`. ESLint erzwingt das.
- Neue Tabelle/Spalte nur über eine neue Datei in `packages/server/migrations/`.
- Tests brauchen Docker. Nie gegen eine fremde Datenbank testen.
- UI- und Fehlertexte: deutsch, kurz, aktiv, Begriffe aus dem Glossar (NEW_DESIGN.md §2).

## Befehle
`npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 3: Server-Paket schreiben**

`packages/server/package.json`:
```json
{
  "name": "@ccg/server",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint .",
    "test": "vitest run",
    "dev:app": "tsx watch src/app/main.ts",
    "start:app": "node dist/app/main.js",
    "start:scheduler": "node dist/scheduler/main.js"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/server/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 120_000 },
});
```

`packages/server/eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  ...tseslint.configs.recommended,
);
```

`packages/server/test/smoke.test.ts`:
```ts
import { expect, it } from 'vitest';

it('runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Abhängigkeiten installieren**

```bash
cd "C:/Users/streamer/Documents/Projekte/CC/CC-Giveaway-NG"
npm install -w @ccg/server pg ioredis fastify zod
npm install -D -w @ccg/server typescript @types/node @types/pg vitest tsx eslint typescript-eslint testcontainers @testcontainers/postgresql
```

- [ ] **Step 5: Prüfen**

Run: `npm run typecheck && npm run lint && npm test`
Expected: alle drei grün, Vitest meldet `1 passed`.

- [ ] **Step 6: Spec umziehen**

```bash
cd "C:/Users/streamer/Documents/Projekte/CC"
cp CC-Giveaway/NEW_DESIGN.md CC-Giveaway-NG/NEW_DESIGN.md
```

Ersetze den Inhalt von `CC-Giveaway/NEW_DESIGN.md` vollständig durch:
```markdown
# NEW_DESIGN.md – umgezogen

Das Design des Neubaus liegt jetzt im neuen Repository:
`C:\Users\streamer\Documents\Projekte\CC\CC-Giveaway-NG\NEW_DESIGN.md`
```

Ersetze in `CC-Giveaway/CLAUDE.md` im Block „NEUBAU — PFLICHTLEKTÜRE“ den Link `[NEW_DESIGN.md](NEW_DESIGN.md)` durch `[../CC-Giveaway-NG/NEW_DESIGN.md](../CC-Giveaway-NG/NEW_DESIGN.md)`.

Ändere in `CC-Giveaway-NG/NEW_DESIGN.md` die Zeile 13 der Tabelle in §13 auf:
`| 13 | Spec-Ort | \`NEW_DESIGN.md\` im Repo CC-Giveaway-NG, Pflichtverweis in beiden \`CLAUDE.md\` |`

- [ ] **Step 7: Commit (beide Repos)**

```bash
cd "C:/Users/streamer/Documents/Projekte/CC/CC-Giveaway-NG"
git add -A
git commit -m "chore: Repository-Geruest, CI und Spec"
cd ../CC-Giveaway
git add NEW_DESIGN.md CLAUDE.md
git commit -m "docs: NEW_DESIGN.md ins Repo CC-Giveaway-NG umgezogen"
```

- [ ] **Step 8: GitHub-Repo (nur nach ausdrücklicher Bestätigung des Betreibers)**

Frage den Betreiber, ob ein privates GitHub-Repo angelegt und gepusht werden soll. Erst nach „ja“:
```bash
cd "C:/Users/streamer/Documents/Projekte/CC/CC-Giveaway-NG"
gh repo create CC-Giveaway-NG --private --source . --push
```
Expected: CI-Lauf auf GitHub wird grün (`gh run watch`).

---

### Task 2: Architektur-Regel – Kerne importieren nur `kernel-api`

**Files:**
- Modify: `packages/server/eslint.config.js`
- Test: `packages/server/test/architecture.test.ts`

**Interfaces:**
- Consumes: ESLint-Konfiguration aus Task 1
- Produces: Regel `no-restricted-imports` für `src/kernel-api/**` und `src/kernels/**`

- [ ] **Step 1: Failing test schreiben**

`packages/server/test/architecture.test.ts`:
```ts
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function restricted(file: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return (result?.messages ?? []).some((m) => m.ruleId === 'no-restricted-imports');
}

describe('Modulgrenzen (NEW_DESIGN.md 3.4)', () => {
  it('kernel darf journal nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../../journal/journal.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf framework nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../../framework/command-bus.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf keinen anderen kernel importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../other/index.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf pg und node-Module nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import pg from 'pg';\nexport const y = pg;\n")).toBe(true);
    expect(await restricted('src/kernels/demo/index.ts', "import fs from 'node:fs';\nexport const y = fs;\n")).toBe(true);
  });
  it('kernel darf kernel-api und eigene Dateien importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import type { X } from '../../kernel-api/index.js';\nimport { h } from './helper.js';\nexport const y: X | undefined = h;\n")).toBe(false);
  });
  it('kernel-api importiert nichts aus src', async () => {
    expect(await restricted('src/kernel-api/index.ts', "import { x } from '../journal/types.js';\nexport const y = x;\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- architecture`
Expected: FAIL – fünf Tests erwarten `true`, bekommen `false`.

- [ ] **Step 3: Regel einbauen**

`packages/server/eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

const NODE_AND_IO = '^(pg|ioredis|fastify|node:.*|fs|net|http|https|crypto|child_process)$';

export default tseslint.config(
  { ignores: ['dist/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/kernel-api/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^\\.\\./', message: 'kernel-api enthält nur Typen und importiert nichts aus src.' },
          { regex: NODE_AND_IO, message: 'kernel-api enthält nur Typen und importiert keine Bibliotheken für I/O.' },
        ],
      }],
    },
  },
  {
    files: ['src/kernels/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^\\.\\./(?!\\.\\./kernel-api(/|$))', message: 'Ein Kern importiert nur kernel-api (NEW_DESIGN.md 3.4).' },
          { regex: NODE_AND_IO, message: 'Ein Kern ist rein und nutzt kein I/O (NEW_DESIGN.md 4).' },
        ],
      }],
    },
  },
);
```

Hinweis: Kerne liegen flach als `src/kernels/<id>/*.ts`. Tiefere Unterordner würden `../../../kernel-api` brauchen und von der Regel blockiert.

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -w @ccg/server -- architecture && npm run lint`
Expected: PASS, 6 Tests grün, Lint grün.

- [ ] **Step 5: Commit**

```bash
git add packages/server/eslint.config.js packages/server/test/architecture.test.ts
git commit -m "chore(lint): Kerne duerfen nur kernel-api importieren"
```

---

### Task 3: Konfiguration

**Files:**
- Create: `packages/server/src/config/config.ts`, `.env.example`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  ```ts
  export interface Config { nodeEnv: 'development'|'test'|'production'; databaseUrl: string; redisUrl: string; port: number; logLevel: 'fatal'|'error'|'warn'|'info'|'debug'|'trace'; }
  export class ConfigError extends Error { readonly problems: string[] }
  export function loadConfig(env: Record<string, string | undefined>): Config
  ```

- [ ] **Step 1: Failing test schreiben**

`packages/server/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5433/ccg',
  REDIS_URL: 'redis://localhost:6380',
};

describe('loadConfig', () => {
  it('reads valid env with defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      port: 3000,
      logLevel: 'info',
    });
  });

  it('coerces PORT', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).port).toBe(8080);
  });

  it('lists every problem at once', () => {
    let err: unknown;
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const problems = (err as ConfigError).problems;
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.join('\n')).toMatch(/PORT/);
    expect(problems.join('\n')).toMatch(/LOG_LEVEL/);
    expect((err as ConfigError).message).toMatch(/^Der Start ist abgebrochen/);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- config`
Expected: FAIL – Modul `../src/config/config.js` fehlt.

- [ ] **Step 3: Implementieren**

`packages/server/src/config/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  REDIS_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  PORT: z.coerce.number({ message: 'Keine Zahl.' }).int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Der Start ist abgebrochen. Korrigiere diese Werte in der Umgebung:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const v = parsed.data;
  return { nodeEnv: v.NODE_ENV, databaseUrl: v.DATABASE_URL, redisUrl: v.REDIS_URL, port: v.PORT, logLevel: v.LOG_LEVEL };
}
```

Hinweis: `{ message }` funktioniert in zod 3 und zod 4. Meldet zod 4 eine Deprecation-Warnung, bleibt der Code so. Der Test entscheidet.

`.env.example` (Repo-Root):
```
NODE_ENV=development
DATABASE_URL=postgres://ccg:ccg@localhost:5433/ccg
REDIS_URL=redis://localhost:6380
PORT=3000
LOG_LEVEL=info
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -w @ccg/server -- config`
Expected: PASS, 3 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config packages/server/test/config.test.ts .env.example
git commit -m "feat(config): typisierte Konfiguration, Start bricht mit allen Fehlern ab"
```

---

### Task 4: Datenbank-Zugang, Migrations-Runner, Test-Datenbanken

**Files:**
- Create: `packages/server/src/db/pool.ts`, `packages/server/src/db/migrate.ts`, `packages/server/migrations/.gitkeep`
- Create: `packages/server/test/global-setup.ts`, `packages/server/test/helpers/db.ts`
- Modify: `packages/server/vitest.config.ts`
- Test: `packages/server/test/migrate.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  ```ts
  // db/pool.ts
  export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;
  export function createPool(url: string): pg.Pool;
  export function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  // db/migrate.ts
  export const MIGRATIONS_DIR: string;
  export function runMigrations(pool: pg.Pool, dir?: string): Promise<string[]>; // Namen der neu angewendeten Dateien
  // test/helpers/db.ts
  export const AT: Date; // 2026-10-15T12:00:00Z, feste Testzeit
  export function freshDb(): Promise<{ pool: pg.Pool; url: string; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Test-Infrastruktur schreiben**

`packages/server/test/global-setup.ts`:
```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('pgUrl', pg.getConnectionUri());
  return async () => {
    await pg.stop();
  };
}
```

`packages/server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
```

`packages/server/test/helpers/db.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';

export const AT = new Date('2026-10-15T12:00:00Z');

export async function freshDb(opts: { migrate?: boolean } = {}) {
  const base = inject('pgUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 30 });
  if (opts.migrate !== false) await runMigrations(pool);
  return { pool, url: url.toString(), close: () => pool.end() };
}
```

- [ ] **Step 2: Failing test schreiben**

`packages/server/test/migrate.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { withTx } from '../src/db/pool.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function dirWith(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
  for (const [n, sql] of Object.entries(files)) await writeFile(path.join(dir, n), sql);
  return dir;
}

describe('runMigrations', () => {
  it('applies files in order exactly once', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    const dir = await dirWith({
      '002_b.sql': 'INSERT INTO t (v) VALUES (2);',
      '001_a.sql': 'CREATE TABLE t (v INT);',
      'readme.txt': 'ignored',
    });
    expect(await runMigrations(db.pool, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
    const r = await db.pool.query('SELECT v FROM t');
    expect(r.rows).toEqual([{ v: 2 }]);
  });

  it('rolls back everything and names the broken file', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    const dir = await dirWith({ '001_a.sql': 'CREATE TABLE t (v INT);', '002_b.sql': 'THIS IS NOT SQL;' });
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/002_b\.sql/);
    const r = await db.pool.query("SELECT to_regclass('t') AS t");
    expect(r.rows[0].t).toBeNull();
  });

  it('withTx rolls back on error', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    await db.pool.query('CREATE TABLE x (v INT)');
    await expect(withTx(db.pool, async (c) => {
      await c.query('INSERT INTO x VALUES (1)');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM x')).rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- migrate`
Expected: FAIL – `../src/db/migrate.js` fehlt.

- [ ] **Step 4: Implementieren**

`packages/server/src/db/pool.ts`:
```ts
import pg from 'pg';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
```

`packages/server/src/db/migrate.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTx } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 4242000;

export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      try {
        await c.query(sql);
      } catch (e) {
        throw new Error(`Migration ${f} ist fehlgeschlagen: ${(e as Error).message}`);
      }
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
    }
    return applied;
  });
}
```

Lege `packages/server/migrations/.gitkeep` als leere Datei an.

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test -w @ccg/server`
Expected: PASS – smoke, architecture, config, migrate (3) grün. Docker muss laufen.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(db): Pool, Transaktionen, Migrations-Runner, Test-Datenbanken"
```

---

### Task 5: Journal-Typen, Identitäts-Schutz, Ereignistypen-Registry

**Files:**
- Create: `packages/server/src/shared/rejection.ts`, `src/journal/types.ts`, `src/journal/guard.ts`, `src/journal/event-types.ts`
- Create: `packages/server/test/helpers/fixtures.ts`
- Test: `packages/server/test/event-types.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  ```ts
  // shared/rejection.ts
  export interface Rejection { rejected: true; code: string; message: string }
  export function reject(code: string, message: string): Rejection;
  export function isRejection(x: unknown): x is Rejection;
  // journal/types.ts
  export type StreamId = string; export type Actor = string; export type EventId = string;
  export interface NewEvent { type: string; payload: unknown; reason?: string; reversesEventId?: EventId }
  export interface EventRecord { id: EventId; stream: StreamId; seq: number; type: string; typeVersion: number; payload: unknown; actor: Actor; reason: string | null; reversesEventId: EventId | null; correlationId: string; createdAt: Date }
  export class JournalError extends Error { readonly code: string }
  export function assertStreamId(s: string): void;
  export function assertActor(a: string): void;
  // journal/guard.ts
  export function assertNoTwitchIdentity(value: unknown, path?: string): void;
  // journal/event-types.ts
  export type ReversalSpec = { kind: 'compensate'; inverse: (target: EventRecord, state: unknown) => NewEvent | Rejection } | { kind: 'void' } | { kind: 'none'; why: string };
  export interface EventTypeDef { type: string; version: number; schema: z.ZodTypeAny; reversal: ReversalSpec; requiresReason?: boolean; upcasters?: Record<number, (payload: unknown) => unknown> }
  export interface PreparedEvent { type: string; typeVersion: number; payload: unknown; reason: string | null; reversesEventId: EventId | null }
  export class EventTypeRegistry { register(def: EventTypeDef): void; get(type: string): EventTypeDef; prepare(e: NewEvent): PreparedEvent; upcast(r: EventRecord): EventRecord }
  // test/helpers/fixtures.ts
  export const STREAM: string; export const OTHER_STREAM: string; export const ACTOR: string;
  export interface CounterState { total: number }
  export function testRegistry(): EventTypeRegistry; // counter_incremented (compensate, prüft Zustand), counter_decremented (compensate), counter_corrected (none, requiresReason), note_sent (none, v2 mit Upcaster), thing_drawn (void)
  export function rejectNegative(state: CounterState, by: number): Rejection | null;
  ```

- [ ] **Step 1: Fixtures schreiben**

`packages/server/test/helpers/fixtures.ts`:
```ts
import { z } from 'zod';
import { EventTypeRegistry } from '../../src/journal/event-types.js';
import type { EventRecord } from '../../src/journal/types.js';
import { reject } from '../../src/shared/rejection.js';

export const STREAM = 'giveaway:11111111-1111-4111-8111-111111111111';
export const OTHER_STREAM = 'giveaway:33333333-3333-4333-8333-333333333333';
export const ACTOR = 'user:22222222-2222-4222-8222-222222222222';

export interface CounterState { total: number }

export function testRegistry(): EventTypeRegistry {
  const r = new EventTypeRegistry();
  const by = z.object({ by: z.number().int().positive() });
  r.register({
    type: 'counter_incremented',
    version: 1,
    schema: by,
    reversal: {
      kind: 'compensate',
      inverse: (t: EventRecord, state: unknown) => {
        const amount = (t.payload as { by: number }).by;
        return rejectNegative(state as CounterState, amount) ?? { type: 'counter_decremented', payload: { by: amount } };
      },
    },
  });
  r.register({
    type: 'counter_decremented',
    version: 1,
    schema: by,
    reversal: { kind: 'compensate', inverse: (t: EventRecord) => ({ type: 'counter_incremented', payload: { by: (t.payload as { by: number }).by } }) },
  });
  r.register({
    type: 'counter_corrected',
    version: 1,
    schema: z.object({ to: z.number().int() }),
    requiresReason: true,
    reversal: { kind: 'none', why: 'Eine Korrektur hebst du mit einer neuen Korrektur auf.' },
  });
  r.register({
    type: 'note_sent',
    version: 2,
    schema: z.object({ text: z.string(), channel: z.string() }),
    upcasters: { 1: (p) => ({ ...(p as object), channel: 'unbekannt' }) },
    reversal: { kind: 'none', why: 'Eine gesendete Chatnachricht lässt sich nicht zurückholen.' },
  });
  r.register({
    type: 'thing_drawn',
    version: 1,
    schema: z.object({ winner: z.string().uuid() }),
    reversal: { kind: 'void' },
  });
  return r;
}

export function rejectNegative(state: CounterState, by: number) {
  return state.total < by ? reject('would_go_negative', 'Der Zähler würde negativ. Nimm zuerst die späteren Einträge zurück.') : null;
}
```

- [ ] **Step 2: Failing test schreiben**

`packages/server/test/event-types.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventTypeRegistry } from '../src/journal/event-types.js';
import { assertNoTwitchIdentity } from '../src/journal/guard.js';
import { JournalError, assertActor, assertStreamId, type EventRecord } from '../src/journal/types.js';
import { isRejection, reject } from '../src/shared/rejection.js';
import { testRegistry } from './helpers/fixtures.js';

const record = (over: Partial<EventRecord>): EventRecord => ({
  id: '1', stream: 'platform', seq: 1, type: 'note_sent', typeVersion: 1, payload: {}, actor: 'system:scheduler',
  reason: null, reversesEventId: null, correlationId: '00000000-0000-4000-8000-000000000000', createdAt: new Date(0), ...over,
});

describe('EventTypeRegistry', () => {
  it('prepare stamps current version and validates payload', () => {
    const p = testRegistry().prepare({ type: 'counter_incremented', payload: { by: 2 } });
    expect(p).toEqual({ type: 'counter_incremented', typeVersion: 1, payload: { by: 2 }, reason: null, reversesEventId: null });
  });

  it('prepare rejects invalid payload with code invalid_payload', () => {
    expect(() => testRegistry().prepare({ type: 'counter_incremented', payload: { by: -1 } }))
      .toThrow(expect.objectContaining({ code: 'invalid_payload' }));
  });

  it('prepare rejects unknown type', () => {
    expect(() => testRegistry().prepare({ type: 'nope', payload: {} })).toThrow(expect.objectContaining({ code: 'unknown_event_type' }));
  });

  it('prepare requires reason for requiresReason types and for reversals', () => {
    const r = testRegistry();
    expect(() => r.prepare({ type: 'counter_corrected', payload: { to: 1 } })).toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(() => r.prepare({ type: 'counter_decremented', payload: { by: 1 }, reversesEventId: '5', reason: '  ' }))
      .toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(r.prepare({ type: 'counter_corrected', payload: { to: 1 }, reason: 'Zählfehler' }).reason).toBe('Zählfehler');
  });

  it('upcast runs the chain up to the current version', () => {
    const up = testRegistry().upcast(record({ type: 'note_sent', typeVersion: 1, payload: { text: 'hi' } }));
    expect(up.typeVersion).toBe(2);
    expect(up.payload).toEqual({ text: 'hi', channel: 'unbekannt' });
  });

  it('register refuses duplicates and missing upcasters', () => {
    const r = testRegistry();
    expect(() => r.register({ type: 'note_sent', version: 1, schema: z.object({}), reversal: { kind: 'void' } })).toThrow(/doppelt/);
    expect(() => new EventTypeRegistry().register({ type: 'x', version: 3, schema: z.object({}), reversal: { kind: 'void' }, upcasters: { 1: (p) => p } }))
      .toThrow(/Upcaster fehlt: x v2→v3/);
  });
});

describe('assertNoTwitchIdentity', () => {
  it('rejects twitch identity keys at any depth', () => {
    for (const key of ['twitchId', 'twitch_id', 'login', 'userName', 'user_name', 'displayName', 'display_name', 'twitch_login']) {
      expect(() => assertNoTwitchIdentity({ entries: [{ pid: 'a', [key]: 'x' }] }), key).toThrow(JournalError);
    }
  });
  it('accepts pid-only payloads', () => {
    expect(() => assertNoTwitchIdentity({ entries: [{ pid: 'a', sek: 60 }], minute: '2026-10-15T12:00Z' })).not.toThrow();
  });
  it('prepare applies the guard', () => {
    const r = new EventTypeRegistry();
    r.register({ type: 'leaky', version: 1, schema: z.object({ login: z.string() }), reversal: { kind: 'void' } });
    expect(() => r.prepare({ type: 'leaky', payload: { login: 'bob' } })).toThrow(expect.objectContaining({ code: 'identity_in_payload' }));
  });
});

describe('ids and rejection', () => {
  it('validates stream ids and actors', () => {
    expect(() => assertStreamId('giveaway:11111111-1111-4111-8111-111111111111')).not.toThrow();
    expect(() => assertStreamId('platform')).not.toThrow();
    expect(() => assertStreamId('giveaway:abc')).toThrow(JournalError);
    expect(() => assertActor('system:scheduler')).not.toThrow();
    expect(() => assertActor('user:22222222-2222-4222-8222-222222222222')).not.toThrow();
    expect(() => assertActor('system:bot')).toThrow(JournalError);
  });
  it('reject builds a recognizable rejection', () => {
    const r = reject('x', 'y');
    expect(isRejection(r)).toBe(true);
    expect(isRejection({ code: 'x' })).toBe(false);
  });
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- event-types`
Expected: FAIL – Module fehlen.

- [ ] **Step 4: Implementieren**

`packages/server/src/shared/rejection.ts`:
```ts
export interface Rejection {
  rejected: true;
  code: string;
  message: string;
}

export function reject(code: string, message: string): Rejection {
  return { rejected: true, code, message };
}

export function isRejection(x: unknown): x is Rejection {
  return typeof x === 'object' && x !== null && (x as { rejected?: unknown }).rejected === true;
}
```

`packages/server/src/journal/types.ts`:
```ts
export type StreamId = string;
export type Actor = string;
export type EventId = string;

export interface NewEvent {
  type: string;
  payload: unknown;
  reason?: string;
  reversesEventId?: EventId;
}

export interface EventRecord {
  id: EventId;
  stream: StreamId;
  seq: number;
  type: string;
  typeVersion: number;
  payload: unknown;
  actor: Actor;
  reason: string | null;
  reversesEventId: EventId | null;
  correlationId: string;
  createdAt: Date;
}

export class JournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STREAM_RE = new RegExp(`^(platform|(giveaway|team|account):${UUID})$`);
const ACTOR_RE = new RegExp(`^(user:${UUID}|system:(ingest|scheduler|twitch))$`);

export function assertStreamId(s: string): void {
  if (!STREAM_RE.test(s)) throw new JournalError('invalid_stream', `Unbekannter Strom: ${s}`);
}

export function assertActor(a: string): void {
  if (!ACTOR_RE.test(a)) throw new JournalError('invalid_actor', `Unbekannter Akteur: ${a}`);
}
```

`packages/server/src/journal/guard.ts`:
```ts
import { JournalError } from './types.js';

const FORBIDDEN = /^(twitch_?id|twitch_?login|login|user_?name|display_?name)$/i;

export function assertNoTwitchIdentity(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoTwitchIdentity(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN.test(k)) {
      throw new JournalError('identity_in_payload', `Das Feld ${path}.${k} enthält Twitch-Daten. Ereignisse speichern nur die pid.`);
    }
    assertNoTwitchIdentity(v, `${path}.${k}`);
  }
}
```

`packages/server/src/journal/event-types.ts`:
```ts
import type { z } from 'zod';
import type { Rejection } from '../shared/rejection.js';
import { assertNoTwitchIdentity } from './guard.js';
import { JournalError, type EventId, type EventRecord, type NewEvent } from './types.js';

export type ReversalSpec =
  | { kind: 'compensate'; inverse: (target: EventRecord, state: unknown) => NewEvent | Rejection }
  | { kind: 'void' }
  | { kind: 'none'; why: string };

export interface EventTypeDef {
  type: string;
  version: number;
  schema: z.ZodTypeAny;
  reversal: ReversalSpec;
  requiresReason?: boolean;
  /** upcasters[n] übersetzt Payload-Version n nach n+1. */
  upcasters?: Record<number, (payload: unknown) => unknown>;
}

export interface PreparedEvent {
  type: string;
  typeVersion: number;
  payload: unknown;
  reason: string | null;
  reversesEventId: EventId | null;
}

export class EventTypeRegistry {
  private readonly defs = new Map<string, EventTypeDef>();

  register(def: EventTypeDef): void {
    if (this.defs.has(def.type)) throw new Error(`Ereignistyp doppelt registriert: ${def.type}`);
    for (let v = 1; v < def.version; v++) {
      if (!def.upcasters?.[v]) throw new Error(`Upcaster fehlt: ${def.type} v${v}→v${v + 1}`);
    }
    this.defs.set(def.type, def);
  }

  get(type: string): EventTypeDef {
    const def = this.defs.get(type);
    if (!def) throw new JournalError('unknown_event_type', `Unbekannter Ereignistyp: ${type}`);
    return def;
  }

  prepare(e: NewEvent): PreparedEvent {
    const def = this.get(e.type);
    const reason = e.reason?.trim() ? e.reason.trim() : null;
    if ((def.requiresReason || e.reversesEventId) && !reason) {
      throw new JournalError('reason_required', `Für ${e.type} fehlt ein Grund.`);
    }
    const parsed = def.schema.safeParse(e.payload);
    if (!parsed.success) {
      throw new JournalError('invalid_payload', `Ungültige Daten für ${e.type}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    assertNoTwitchIdentity(parsed.data);
    return { type: e.type, typeVersion: def.version, payload: parsed.data, reason, reversesEventId: e.reversesEventId ?? null };
  }

  upcast(r: EventRecord): EventRecord {
    const def = this.get(r.type);
    let payload = r.payload;
    for (let v = r.typeVersion; v < def.version; v++) payload = def.upcasters![v]!(payload);
    return { ...r, payload, typeVersion: def.version };
  }
}
```

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test -w @ccg/server -- event-types && npm run typecheck`
Expected: PASS, 11 Tests grün, Typecheck grün.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/shared packages/server/src/journal packages/server/test
git commit -m "feat(journal): Ereignistypen, Umkehrarten, Upcaster, Schutz vor Twitch-Daten"
```

---

### Task 6: Journal-Schema, Partitionen, Anhängen und Lesen

**Files:**
- Create: `packages/server/migrations/001_journal.sql`, `src/journal/partitions.ts`, `src/journal/journal.ts`
- Delete: `packages/server/migrations/.gitkeep`
- Modify: `packages/server/test/helpers/db.ts` (Partitionen für `AT` anlegen)
- Test: `packages/server/test/journal.test.ts`

**Interfaces:**
- Consumes: `withTx`, `Queryable` (Task 4); `EventTypeRegistry`, `NewEvent`, `EventRecord`, `assertStreamId`, `assertActor` (Task 5)
- Produces:
  ```ts
  // journal/partitions.ts
  export function partitionName(d: Date): string; // events_y2026m10
  export function ensurePartitions(pool: pg.Pool, now: Date, monthsAhead?: number): Promise<string[]>;
  export function isMissingPartition(e: unknown): boolean;
  // journal/journal.ts
  export interface AppendArgs { stream: StreamId; lastSeq: number; events: NewEvent[]; actor: Actor; correlationId: string; at: Date }
  export function lockStream(c: pg.PoolClient, stream: StreamId): Promise<number>;
  export function appendLocked(c: pg.PoolClient, registry: EventTypeRegistry, a: AppendArgs): Promise<EventRecord[]>;
  export function readStream(db: Queryable, registry: EventTypeRegistry, stream: StreamId, afterSeq?: number): Promise<EventRecord[]>;
  export function readEvent(db: Queryable, registry: EventTypeRegistry, id: EventId): Promise<EventRecord | null>;
  export function isReverted(db: Queryable, id: EventId): Promise<boolean>;
  export function rowToRecord(row: EventRow): EventRecord;
  ```

- [ ] **Step 1: Failing test schreiben**

`packages/server/test/journal.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { appendLocked, isReverted, lockStream, readEvent, readStream } from '../src/journal/journal.js';
import { ensurePartitions, partitionName } from '../src/journal/partitions.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, STREAM, testRegistry } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup() {
  const db = await freshDb();
  close = db.close;
  return db.pool;
}

describe('partitions', () => {
  it('names partitions by UTC month', () => {
    expect(partitionName(new Date('2026-12-31T23:59:59Z'))).toBe('events_y2026m12');
    expect(partitionName(new Date('2027-01-01T00:00:00Z'))).toBe('events_y2027m01');
  });

  it('creates current and next months idempotently', async () => {
    const pool = await setup();
    expect(await ensurePartitions(pool, new Date('2026-12-10T00:00:00Z'), 2)).toEqual(['events_y2026m12', 'events_y2027m01', 'events_y2027m02']);
    await ensurePartitions(pool, new Date('2026-12-10T00:00:00Z'), 2);
    const r = await pool.query("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'events'::regclass");
    expect(r.rows[0].n).toBeGreaterThanOrEqual(3);
  });
});

describe('append and read', () => {
  it('appends with gapless seq and reads back upcasted', async () => {
    const pool = await setup();
    const corr = randomUUID();
    const written = await withTx(pool, async (c) => {
      const last = await lockStream(c, STREAM);
      expect(last).toBe(0);
      return appendLocked(c, registry, {
        stream: STREAM, lastSeq: last, actor: ACTOR, correlationId: corr, at: AT,
        events: [{ type: 'counter_incremented', payload: { by: 1 } }, { type: 'counter_incremented', payload: { by: 2 } }],
      });
    });
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    const read = await readStream(pool, registry, STREAM);
    expect(read).toEqual(written);
    expect(await readStream(pool, registry, STREAM, 1)).toEqual([written[1]]);
    expect(await readEvent(pool, registry, written[0]!.id)).toEqual(written[0]);
    expect(await readEvent(pool, registry, '999999')).toBeNull();
    const head = await pool.query('SELECT last_seq FROM stream_heads WHERE stream = $1', [STREAM]);
    expect(head.rows[0].last_seq).toBe(2);
  });

  it('upcasts old rows on read', async () => {
    const pool = await setup();
    await pool.query("INSERT INTO stream_heads (stream, last_seq) VALUES ($1, 1)", [STREAM]);
    await pool.query(
      `INSERT INTO events (stream, seq, type, type_version, payload, actor, correlation_id, created_at)
       VALUES ($1, 1, 'note_sent', 1, '{"text":"alt"}', $2, $3, $4)`,
      [STREAM, ACTOR, randomUUID(), AT],
    );
    const [e] = await readStream(pool, registry, STREAM);
    expect(e!.typeVersion).toBe(2);
    expect(e!.payload).toEqual({ text: 'alt', channel: 'unbekannt' });
  });

  it('refuses UPDATE, DELETE and TRUNCATE on events', async () => {
    const pool = await setup();
    await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    await expect(pool.query("UPDATE events SET type = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM events')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE events')).rejects.toThrow(/append-only/);
  });

  it('marks reverted events', async () => {
    const pool = await setup();
    const [first] = await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    expect(await isReverted(pool, first!.id)).toBe(false);
    await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_decremented', payload: { by: 1 }, reversesEventId: first!.id, reason: 'Test' }],
    }));
    expect(await isReverted(pool, first!.id)).toBe(true);
  });

  it('rejects invalid actor and invalid stream', async () => {
    const pool = await setup();
    await expect(withTx(pool, (c) => lockStream(c, 'giveaway:nope'))).rejects.toThrow(/Unbekannter Strom/);
    await expect(withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: 'someone', correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }))).rejects.toThrow(/Unbekannter Akteur/);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- journal`
Expected: FAIL – Module und Tabellen fehlen.

- [ ] **Step 3: Migration schreiben**

`packages/server/migrations/001_journal.sql`:
```sql
CREATE TABLE stream_heads (
  stream   TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE SEQUENCE events_id_seq AS BIGINT;

CREATE TABLE events (
  id                BIGINT NOT NULL DEFAULT nextval('events_id_seq'),
  stream            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  type_version      INTEGER NOT NULL,
  payload           JSONB NOT NULL,
  actor             TEXT NOT NULL,
  reason            TEXT,
  reverses_event_id BIGINT,
  correlation_id    UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

ALTER SEQUENCE events_id_seq OWNED BY events.id;

CREATE INDEX events_stream_seq ON events (stream, seq);
CREATE INDEX events_reverses ON events (reverses_event_id) WHERE reverses_event_id IS NOT NULL;
CREATE INDEX events_id ON events (id);

CREATE TABLE snapshots (
  stream          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  reducer         TEXT NOT NULL,
  reducer_version INTEGER NOT NULL,
  state           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (stream, reducer, reducer_version, seq)
);

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events ist append-only. Schreibe ein Gegen-Ereignis statt zu ändern oder zu löschen.';
END
$$;

CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
```

Lösche `packages/server/migrations/.gitkeep`.

- [ ] **Step 4: Partitionen implementieren**

`packages/server/src/journal/partitions.ts`:
```ts
import type pg from 'pg';
import { withTx } from '../db/pool.js';

const LOCK_KEY = 4242001;

export function partitionName(d: Date): string {
  return `events_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function ensurePartitions(pool: pg.Pool, now: Date, monthsAhead = 2): Promise<string[]> {
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const names: string[] = [];
    for (let i = 0; i <= monthsAhead; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
      const name = partitionName(start);
      await c.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
      );
      names.push(name);
    }
    return names;
  });
}

export function isMissingPartition(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23514' && /no partition of relation/.test(err.message ?? '');
}
```

- [ ] **Step 5: Journal implementieren**

`packages/server/src/journal/journal.ts`:
```ts
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import type { EventTypeRegistry } from './event-types.js';
import { assertActor, assertStreamId, type Actor, type EventId, type EventRecord, type NewEvent, type StreamId } from './types.js';

export interface AppendArgs {
  stream: StreamId;
  lastSeq: number;
  events: NewEvent[];
  actor: Actor;
  correlationId: string;
  at: Date;
}

export interface EventRow {
  id: string;
  stream: string;
  seq: number;
  type: string;
  type_version: number;
  payload: unknown;
  actor: string;
  reason: string | null;
  reverses_event_id: string | null;
  correlation_id: string;
  created_at: Date;
}

const COLUMNS = 'id, stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at';

export function rowToRecord(row: EventRow): EventRecord {
  return {
    id: String(row.id),
    stream: row.stream,
    seq: row.seq,
    type: row.type,
    typeVersion: row.type_version,
    payload: row.payload,
    actor: row.actor,
    reason: row.reason,
    reversesEventId: row.reverses_event_id === null ? null : String(row.reverses_event_id),
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

/** Sperrt den Strom bis zum Ende der Transaktion und liefert die letzte seq. */
export async function lockStream(c: pg.PoolClient, stream: StreamId): Promise<number> {
  assertStreamId(stream);
  await c.query('INSERT INTO stream_heads (stream, last_seq) VALUES ($1, 0) ON CONFLICT (stream) DO NOTHING', [stream]);
  const r = await c.query<{ last_seq: number }>('SELECT last_seq FROM stream_heads WHERE stream = $1 FOR UPDATE', [stream]);
  return r.rows[0]!.last_seq;
}

/** Nur nach lockStream in derselben Transaktion aufrufen. */
export async function appendLocked(c: pg.PoolClient, registry: EventTypeRegistry, a: AppendArgs): Promise<EventRecord[]> {
  assertActor(a.actor);
  if (a.events.length === 0) return [];
  const out: EventRecord[] = [];
  let seq = a.lastSeq;
  for (const e of a.events) {
    const p = registry.prepare(e);
    seq += 1;
    const r = await c.query<{ id: string }>(
      `INSERT INTO events (stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [a.stream, seq, p.type, p.typeVersion, JSON.stringify(p.payload), a.actor, p.reason, p.reversesEventId, a.correlationId, a.at],
    );
    out.push({
      id: String(r.rows[0]!.id), stream: a.stream, seq, type: p.type, typeVersion: p.typeVersion, payload: p.payload,
      actor: a.actor, reason: p.reason, reversesEventId: p.reversesEventId, correlationId: a.correlationId, createdAt: a.at,
    });
  }
  await c.query('UPDATE stream_heads SET last_seq = $2 WHERE stream = $1', [a.stream, seq]);
  return out;
}

export async function readStream(db: Queryable, registry: EventTypeRegistry, stream: StreamId, afterSeq = 0): Promise<EventRecord[]> {
  const r = await db.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE stream = $1 AND seq > $2 ORDER BY seq`, [stream, afterSeq]);
  return r.rows.map((row) => registry.upcast(rowToRecord(row)));
}

export async function readEvent(db: Queryable, registry: EventTypeRegistry, id: EventId): Promise<EventRecord | null> {
  if (!/^\d+$/.test(id)) return null;
  const r = await db.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]);
  return r.rows[0] ? registry.upcast(rowToRecord(r.rows[0])) : null;
}

export async function isReverted(db: Queryable, id: EventId): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM events WHERE reverses_event_id = $1 LIMIT 1', [id]);
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 6: Test-Helfer um Partitionen ergänzen**

In `packages/server/test/helpers/db.ts` den Import ergänzen und nach `runMigrations` die Partitionen für `AT` anlegen:
```ts
import { ensurePartitions } from '../../src/journal/partitions.js';
```
```ts
  if (opts.migrate !== false) {
    await runMigrations(pool);
    await ensurePartitions(pool, AT, 0);
  }
```

- [ ] **Step 7: Tests laufen lassen**

Run: `npm test -w @ccg/server && npm run typecheck`
Expected: PASS, alle bisherigen Tests plus 7 Journal-Tests grün.

- [ ] **Step 8: Commit**

```bash
git add -A packages/server
git commit -m "feat(journal): partitioniertes Journal, Stromsperre, Anhaengen und Lesen"
```

---

### Task 7: Zugriffslog mit Drossel

**Files:**
- Create: `packages/server/migrations/002_access_log.sql`, `src/audit/access-log.ts`
- Test: `packages/server/test/access-log.test.ts`

**Interfaces:**
- Consumes: `withTx`, `Queryable` (Task 4)
- Produces:
  ```ts
  export interface DeniedEntry { actor: string; action: string; reason: string; target?: string | null; ip?: string | null; at: Date }
  export interface ReadEntry { actor: string; action: string; target: string; ip?: string | null; at: Date }
  export const DENY_WINDOW_MS = 5 * 60 * 1000;
  export const IP_RETENTION_DAYS = 30;
  export function logDenied(pool: pg.Pool, e: DeniedEntry): Promise<void>;
  export function logRead(db: Queryable, e: ReadEntry): Promise<void>;
  export function purgeIps(db: Queryable, now: Date): Promise<number>;
  ```

- [ ] **Step 1: Failing test schreiben**

`packages/server/test/access-log.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { logDenied, logRead, purgeIps } from '../src/audit/access-log.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const plus = (ms: number) => new Date(AT.getTime() + ms);

async function setup() {
  const db = await freshDb();
  close = db.close;
  return db.pool;
}

describe('access_log', () => {
  it('throttles denials per actor, action and reason within 5 minutes', async () => {
    const pool = await setup();
    const base = { actor: ACTOR, action: 'pause', reason: 'forbidden', ip: '10.0.0.1' };
    await logDenied(pool, { ...base, at: AT });
    await logDenied(pool, { ...base, at: plus(60_000) });
    await logDenied(pool, { ...base, at: plus(299_000) });
    await logDenied(pool, { ...base, reason: 'not_open', at: plus(1_000) });
    await logDenied(pool, { ...base, at: plus(301_000) });
    const r = await pool.query("SELECT reason, count, first_at, last_at FROM access_log WHERE kind = 'denied' ORDER BY id");
    expect(r.rows.map((x) => [x.reason, x.count])).toEqual([['forbidden', 3], ['not_open', 1], ['forbidden', 1]]);
    expect(r.rows[0].last_at).toEqual(plus(299_000));
  });

  it('parallel denials do not create duplicate rows', async () => {
    const pool = await setup();
    await Promise.all(Array.from({ length: 20 }, () => logDenied(pool, { actor: ACTOR, action: 'pause', reason: 'forbidden', at: AT })));
    const r = await pool.query("SELECT count, (SELECT count(*)::int FROM access_log) AS rows FROM access_log");
    expect(r.rows[0]).toEqual({ count: 20, rows: 1 });
  });

  it('logs reads unthrottled', async () => {
    const pool = await setup();
    await logRead(pool, { actor: ACTOR, action: 'view_participants', target: 'giveaway:x', at: AT });
    await logRead(pool, { actor: ACTOR, action: 'view_participants', target: 'giveaway:x', at: AT });
    const r = await pool.query("SELECT count(*)::int AS n FROM access_log WHERE kind = 'read'");
    expect(r.rows[0].n).toBe(2);
  });

  it('removes IPs after 30 days and keeps the rest', async () => {
    const pool = await setup();
    await logRead(pool, { actor: ACTOR, action: 'a', target: 't', ip: '10.0.0.1', at: AT });
    await logRead(pool, { actor: ACTOR, action: 'b', target: 't', ip: '10.0.0.2', at: plus(20 * 86_400_000) });
    expect(await purgeIps(pool, plus(31 * 86_400_000))).toBe(1);
    const r = await pool.query('SELECT action, host(ip) AS ip FROM access_log ORDER BY id');
    expect(r.rows).toEqual([{ action: 'a', ip: null }, { action: 'b', ip: '10.0.0.2' }]);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- access-log`
Expected: FAIL – Modul und Tabelle fehlen.

- [ ] **Step 3: Migration schreiben**

`packages/server/migrations/002_access_log.sql`:
```sql
CREATE TABLE access_log (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('read', 'denied')),
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  reason   TEXT,
  target   TEXT,
  ip       INET,
  count    INTEGER NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL,
  last_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX access_log_throttle ON access_log (actor, action, reason, first_at) WHERE kind = 'denied';
CREATE INDEX access_log_last_at_ip ON access_log (last_at) WHERE ip IS NOT NULL;
```

- [ ] **Step 4: Implementieren**

`packages/server/src/audit/access-log.ts`:
```ts
import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.js';

export interface DeniedEntry { actor: string; action: string; reason: string; target?: string | null; ip?: string | null; at: Date }
export interface ReadEntry { actor: string; action: string; target: string; ip?: string | null; at: Date }

export const DENY_WINDOW_MS = 5 * 60 * 1000;
export const IP_RETENTION_DAYS = 30;

export async function logDenied(pool: pg.Pool, e: DeniedEntry): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2 || '|' || $3))", [e.actor, e.action, e.reason]);
    const windowStart = new Date(e.at.getTime() - DENY_WINDOW_MS);
    const upd = await c.query(
      `UPDATE access_log SET count = count + 1, last_at = GREATEST(last_at, $4)
       WHERE id = (SELECT id FROM access_log
                   WHERE kind = 'denied' AND actor = $1 AND action = $2 AND reason = $3 AND first_at > $5
                   ORDER BY first_at DESC LIMIT 1)`,
      [e.actor, e.action, e.reason, e.at, windowStart],
    );
    if ((upd.rowCount ?? 0) > 0) return;
    await c.query(
      `INSERT INTO access_log (kind, actor, action, reason, target, ip, first_at, last_at)
       VALUES ('denied', $1, $2, $3, $4, $5, $6, $6)`,
      [e.actor, e.action, e.reason, e.target ?? null, e.ip ?? null, e.at],
    );
  });
}

export async function logRead(db: Queryable, e: ReadEntry): Promise<void> {
  await db.query(
    `INSERT INTO access_log (kind, actor, action, target, ip, first_at, last_at) VALUES ('read', $1, $2, $3, $4, $5, $5)`,
    [e.actor, e.action, e.target, e.ip ?? null, e.at],
  );
}

export async function purgeIps(db: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - IP_RETENTION_DAYS * 86_400_000);
  const r = await db.query('UPDATE access_log SET ip = NULL WHERE ip IS NOT NULL AND last_at < $1', [cutoff]);
  return r.rowCount ?? 0;
}
```

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test -w @ccg/server -- access-log`
Expected: PASS, 4 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add packages/server/migrations/002_access_log.sql packages/server/src/audit packages/server/test/access-log.test.ts
git commit -m "feat(audit): Zugriffslog mit 5-Minuten-Drossel und IP-Frist"
```

---

### Task 8: Projektionen, Snapshots, Push

**Files:**
- Create: `packages/server/src/framework/projections.ts`, `src/framework/publisher.ts`, `src/journal/snapshots.ts`
- Modify: `packages/server/test/helpers/fixtures.ts` (`totalsProjector` ergänzen)
- Test: `packages/server/test/projections.test.ts`, `packages/server/test/publisher.test.ts`

**Interfaces:**
- Consumes: `withTx`, `Queryable` (Task 4); `EventTypeRegistry` (Task 5); `rowToRecord`, `EventRow` (Task 6)
- Produces:
  ```ts
  // framework/projections.ts
  export interface Projector { name: string; handles: readonly string[]; apply(c: pg.PoolClient, e: EventRecord): Promise<void>; reset(c: pg.PoolClient): Promise<void> }
  export class ProjectionRegistry { register(p: Projector): void; applyAll(c: pg.PoolClient, events: EventRecord[]): Promise<void>; rebuild(pool: pg.Pool, registry: EventTypeRegistry, name: string, batchSize?: number): Promise<number> }
  // framework/publisher.ts
  export interface Publisher { publish(stream: StreamId, events: EventRecord[]): Promise<void> }
  export class InMemoryPublisher implements Publisher { readonly messages: { stream: StreamId; events: EventRecord[] }[] }
  export class RedisPublisher implements Publisher { constructor(redis: Redis) }
  export function channelFor(stream: StreamId): string; // `events:${stream}`
  // journal/snapshots.ts
  export interface ReducerRef { name: string; version: number }
  export function loadSnapshot<S>(db: Queryable, stream: StreamId, reducer: ReducerRef): Promise<{ seq: number; state: S } | null>;
  export function saveSnapshot(db: Queryable, stream: StreamId, reducer: ReducerRef, seq: number, state: unknown, at: Date): Promise<void>;
  // test/helpers/fixtures.ts
  export const totalsProjector: Projector; // schreibt in Testtabelle test_totals (stream, total)
  ```

- [ ] **Step 1: Fixture-Projektion ergänzen**

Testdateien importieren nie andere Testdateien (sonst laufen deren Tests doppelt). Darum liegt die Projektion in den Fixtures. An `packages/server/test/helpers/fixtures.ts` anhängen (Imports oben ergänzen):
```ts
import type pg from 'pg';
import type { Projector } from '../../src/framework/projections.js';
```
```ts
export const totalsProjector: Projector = {
  name: 'totals',
  handles: ['counter_incremented', 'counter_decremented'],
  async apply(c: pg.PoolClient, e: EventRecord) {
    const by = (e.payload as { by: number }).by * (e.type === 'counter_incremented' ? 1 : -1);
    await c.query(
      'INSERT INTO test_totals (stream, total) VALUES ($1, $2) ON CONFLICT (stream) DO UPDATE SET total = test_totals.total + $2',
      [e.stream, by],
    );
  },
  async reset(c: pg.PoolClient) {
    await c.query('DELETE FROM test_totals');
  },
};
```

- [ ] **Step 2: Failing tests schreiben**

`packages/server/test/projections.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { appendLocked, lockStream } from '../src/journal/journal.js';
import { loadSnapshot, saveSnapshot } from '../src/journal/snapshots.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, OTHER_STREAM, STREAM, testRegistry, totalsProjector } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup() {
  const db = await freshDb();
  close = db.close;
  await db.pool.query('CREATE TABLE test_totals (stream TEXT PRIMARY KEY, total INT NOT NULL)');
  return db.pool;
}

async function write(pool: pg.Pool, projections: ProjectionRegistry, stream: string, by: number[]) {
  await withTx(pool, async (c) => {
    const events = await appendLocked(c, registry, {
      stream, lastSeq: await lockStream(c, stream), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: by.map((b) => ({ type: b > 0 ? 'counter_incremented' : 'counter_decremented', payload: { by: Math.abs(b) } })),
    });
    await projections.applyAll(c, events);
  });
}

describe('ProjectionRegistry', () => {
  it('applies only handled types and refuses duplicate names', async () => {
    const pool = await setup();
    const p = new ProjectionRegistry();
    p.register(totalsProjector);
    expect(() => p.register(totalsProjector)).toThrow(/doppelt/);
    await write(pool, p, STREAM, [5, -2]);
    await withTx(pool, async (c) => {
      const ev = await appendLocked(c, registry, {
        stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
        events: [{ type: 'note_sent', payload: { text: 'x', channel: 'y' } }],
      });
      await p.applyAll(c, ev);
    });
    const r = await pool.query('SELECT total FROM test_totals WHERE stream = $1', [STREAM]);
    expect(r.rows[0].total).toBe(3);
  });

  it('rebuild equals the incremental result', async () => {
    const pool = await setup();
    const p = new ProjectionRegistry();
    p.register(totalsProjector);
    await write(pool, p, STREAM, [5, -2, 7]);
    await write(pool, p, OTHER_STREAM, [1, 1]);
    const before = (await pool.query('SELECT * FROM test_totals ORDER BY stream')).rows;
    await pool.query('UPDATE test_totals SET total = 999');
    const applied = await p.rebuild(pool, registry, 'totals', 2);
    expect(applied).toBe(5);
    expect((await pool.query('SELECT * FROM test_totals ORDER BY stream')).rows).toEqual(before);
  });
});

describe('snapshots', () => {
  it('returns the newest snapshot of the matching reducer version', async () => {
    const pool = await setup();
    const ref = { name: 'counter', version: 1 };
    expect(await loadSnapshot(pool, STREAM, ref)).toBeNull();
    await saveSnapshot(pool, STREAM, ref, 1000, { total: 1 }, AT);
    await saveSnapshot(pool, STREAM, ref, 2000, { total: 2 }, AT);
    await saveSnapshot(pool, STREAM, { name: 'counter', version: 2 }, 3000, { total: 3 }, AT);
    await saveSnapshot(pool, STREAM, ref, 2000, { total: 99 }, AT);
    expect(await loadSnapshot(pool, STREAM, ref)).toEqual({ seq: 2000, state: { total: 2 } });
  });
});
```

`packages/server/test/publisher.test.ts`:
```ts
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPublisher, RedisPublisher, channelFor } from '../src/framework/publisher.js';
import type { EventRecord } from '../src/journal/types.js';
import { AT } from './helpers/db.js';
import { ACTOR, STREAM } from './helpers/fixtures.js';

const ev: EventRecord = {
  id: '1', stream: STREAM, seq: 1, type: 'counter_incremented', typeVersion: 1, payload: { by: 1 }, actor: ACTOR,
  reason: null, reversesEventId: null, correlationId: '00000000-0000-4000-8000-000000000000', createdAt: AT,
};

let container: StartedTestContainer;
beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
});
afterAll(async () => container?.stop());

describe('publishers', () => {
  it('InMemoryPublisher records messages', async () => {
    const p = new InMemoryPublisher();
    await p.publish(STREAM, [ev]);
    expect(p.messages).toEqual([{ stream: STREAM, events: [ev] }]);
  });

  it('RedisPublisher sends JSON on events:<stream>', async () => {
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const sub = new Redis(url);
    const pub = new Redis(url);
    const got = new Promise<string>((resolve) => sub.on('message', (_ch, msg) => resolve(msg)));
    await sub.subscribe(channelFor(STREAM));
    await new RedisPublisher(pub).publish(STREAM, [ev]);
    const msg = JSON.parse(await got);
    expect(msg).toEqual([{ ...ev, createdAt: AT.toISOString() }]);
    sub.disconnect();
    pub.disconnect();
  });
});
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- projections publisher`
Expected: FAIL – Module fehlen.

- [ ] **Step 4: Implementieren**

`packages/server/src/journal/snapshots.ts`:
```ts
import type { Queryable } from '../db/pool.js';
import type { StreamId } from './types.js';

export interface ReducerRef {
  name: string;
  version: number;
}

export async function loadSnapshot<S>(db: Queryable, stream: StreamId, reducer: ReducerRef): Promise<{ seq: number; state: S } | null> {
  const r = await db.query<{ seq: number; state: S }>(
    'SELECT seq, state FROM snapshots WHERE stream = $1 AND reducer = $2 AND reducer_version = $3 ORDER BY seq DESC LIMIT 1',
    [stream, reducer.name, reducer.version],
  );
  return r.rows[0] ?? null;
}

export async function saveSnapshot(db: Queryable, stream: StreamId, reducer: ReducerRef, seq: number, state: unknown, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO snapshots (stream, seq, reducer, reducer_version, state, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [stream, seq, reducer.name, reducer.version, JSON.stringify(state), at],
  );
}
```

`packages/server/src/framework/projections.ts`:
```ts
import type pg from 'pg';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { rowToRecord, type EventRow } from '../journal/journal.js';
import type { EventRecord } from '../journal/types.js';

export interface Projector {
  name: string;
  handles: readonly string[];
  apply(c: pg.PoolClient, e: EventRecord): Promise<void>;
  reset(c: pg.PoolClient): Promise<void>;
}

export class ProjectionRegistry {
  private readonly projectors: Projector[] = [];

  register(p: Projector): void {
    if (this.projectors.some((x) => x.name === p.name)) throw new Error(`Projektion doppelt registriert: ${p.name}`);
    this.projectors.push(p);
  }

  async applyAll(c: pg.PoolClient, events: EventRecord[]): Promise<void> {
    for (const e of events) {
      for (const p of this.projectors) {
        if (p.handles.includes(e.type)) await p.apply(c, e);
      }
    }
  }

  /**
   * Baut eine Projektion aus dem Journal neu auf. Liefert die Zahl der angewendeten Ereignisse.
   * Läuft in einer Transaktion. Live-Neuaufbau während laufender Befehle regelt Teilprojekt 2.
   */
  async rebuild(pool: pg.Pool, registry: EventTypeRegistry, name: string, batchSize = 1000): Promise<number> {
    const p = this.projectors.find((x) => x.name === name);
    if (!p) throw new Error(`Unbekannte Projektion: ${name}`);
    return withTx(pool, async (c) => {
      await p.reset(c);
      let lastId = '0';
      let applied = 0;
      for (;;) {
        const r = await c.query<EventRow>(
          `SELECT id, stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at
           FROM events WHERE id > $1 AND type = ANY($2) ORDER BY id LIMIT $3`,
          [lastId, [...p.handles], batchSize],
        );
        if (r.rows.length === 0) return applied;
        for (const row of r.rows) {
          await p.apply(c, registry.upcast(rowToRecord(row)));
          applied += 1;
        }
        lastId = String(r.rows[r.rows.length - 1]!.id);
      }
    });
  }
}
```

`packages/server/src/framework/publisher.ts`:
```ts
import type { Redis } from 'ioredis';
import type { EventRecord, StreamId } from '../journal/types.js';

export interface Publisher {
  publish(stream: StreamId, events: EventRecord[]): Promise<void>;
}

export function channelFor(stream: StreamId): string {
  return `events:${stream}`;
}

export class InMemoryPublisher implements Publisher {
  readonly messages: { stream: StreamId; events: EventRecord[] }[] = [];

  async publish(stream: StreamId, events: EventRecord[]): Promise<void> {
    this.messages.push({ stream, events });
  }
}

export class RedisPublisher implements Publisher {
  constructor(private readonly redis: Redis) {}

  async publish(stream: StreamId, events: EventRecord[]): Promise<void> {
    const body = events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
    await this.redis.publish(channelFor(stream), JSON.stringify(body));
  }
}
```

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test -w @ccg/server -- projections publisher && npm run typecheck`
Expected: PASS, 5 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/framework packages/server/src/journal/snapshots.ts packages/server/test
git commit -m "feat(framework): Projektionen mit Neuaufbau, Snapshots, Push ueber Redis"
```

---

### Task 9: Command-Bus

**Files:**
- Create: `packages/server/src/framework/command-bus.ts`
- Modify: `packages/server/test/helpers/fixtures.ts` (Reducer + Handler ergänzen)
- Test: `packages/server/test/command-bus.test.ts`

**Interfaces:**
- Consumes: `withTx` (Task 4); `EventTypeRegistry`, `Rejection`, `isRejection` (Task 5); `lockStream`, `appendLocked`, `readStream`, `ensurePartitions`, `isMissingPartition` (Task 6); `logDenied` (Task 7); `ProjectionRegistry`, `Publisher`, `loadSnapshot`, `saveSnapshot` (Task 8)
- Produces:
  ```ts
  export interface StreamReducer<S> { name: string; version: number; initial(): S; apply(state: S, e: EventRecord): S } // rein, S JSON-serialisierbar
  export interface CommandContext { actor: Actor; correlationId: string; now: Date; ip?: string | null }
  export interface CommandHandler<C, S, P = undefined> {
    type: string;
    streamOf(cmd: C): StreamId;
    reducer: StreamReducer<S>;
    authorize(cmd: C, ctx: CommandContext): Rejection | null;
    prepare?(c: pg.PoolClient, cmd: C, ctx: CommandContext): Promise<P>;
    decide(state: S, cmd: C, ctx: CommandContext, prepared: P): NewEvent[] | Rejection;
  }
  export type CommandResult = { ok: true; events: EventRecord[] } | { ok: false; rejection: Rejection };
  export interface BusLogger { error(obj: object, msg: string): void }
  export interface CommandBusDeps { pool: pg.Pool; registry: EventTypeRegistry; projections: ProjectionRegistry; publisher: Publisher; log: BusLogger; snapshotEvery?: number }
  export const SNAPSHOT_EVERY = 1000;
  export class CommandBus { constructor(deps: CommandBusDeps); execute<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext): Promise<CommandResult>; loadState<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>): Promise<S> }
  // fixtures
  export const counterReducer: StreamReducer<CounterState>;
  export interface IncrementCmd { stream: string; by: number; deny?: boolean }
  export const incrementHandler: CommandHandler<IncrementCmd, CounterState>;
  export function ctx(over?: Partial<CommandContext>): CommandContext;
  ```

- [ ] **Step 1: Fixtures ergänzen**

An `packages/server/test/helpers/fixtures.ts` anhängen (Imports oben ergänzen):
```ts
import { randomUUID } from 'node:crypto';
import type { CommandContext, CommandHandler, StreamReducer } from '../../src/framework/command-bus.js';
import { AT } from './db.js';
```
```ts
export const counterReducer: StreamReducer<CounterState> = {
  name: 'counter',
  version: 1,
  initial: () => ({ total: 0 }),
  apply(state, e) {
    if (e.type === 'counter_incremented') return { total: state.total + (e.payload as { by: number }).by };
    if (e.type === 'counter_decremented') return { total: state.total - (e.payload as { by: number }).by };
    if (e.type === 'counter_corrected') return { total: (e.payload as { to: number }).to };
    return state;
  },
};

export interface IncrementCmd { stream: string; by: number; deny?: boolean }

export const incrementHandler: CommandHandler<IncrementCmd, CounterState> = {
  type: 'increment',
  streamOf: (cmd) => cmd.stream,
  reducer: counterReducer,
  authorize: (cmd) => (cmd.deny ? reject('forbidden', 'Du darfst diesen Zähler nicht ändern.') : null),
  decide: (state, cmd) =>
    state.total + cmd.by > 100
      ? reject('too_big', 'Der Zähler darf 100 nicht überschreiten.')
      : [{ type: 'counter_incremented', payload: { by: cmd.by } }],
};

export function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return { actor: ACTOR, correlationId: randomUUID(), now: AT, ip: '10.0.0.9', ...over };
}
```

- [ ] **Step 2: Failing test schreiben**

`packages/server/test/command-bus.test.ts`:
```ts
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus, type CommandBusDeps } from '../src/framework/command-bus.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { InMemoryPublisher, type Publisher } from '../src/framework/publisher.js';
import { readStream } from '../src/journal/journal.js';
import { AT, freshDb } from './helpers/db.js';
import { STREAM, counterReducer, ctx, incrementHandler, testRegistry, totalsProjector } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup(over: Partial<CommandBusDeps> = {}) {
  const db = await freshDb();
  close = db.close;
  await db.pool.query('CREATE TABLE test_totals (stream TEXT PRIMARY KEY, total INT NOT NULL)');
  const projections = new ProjectionRegistry();
  projections.register(totalsProjector);
  const publisher = new InMemoryPublisher();
  const log = { error: vi.fn() };
  const bus = new CommandBus({ pool: db.pool, registry, projections, publisher, log, ...over });
  return { pool: db.pool, bus, publisher, log, projections };
}

const total = async (pool: pg.Pool) => (await pool.query('SELECT total FROM test_totals WHERE stream = $1', [STREAM])).rows[0]?.total ?? 0;

describe('CommandBus', () => {
  it('executes: journal, projection and push', async () => {
    const { pool, bus, publisher } = await setup();
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 3 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => [e.seq, e.type])).toEqual([[1, 'counter_incremented']]);
    expect(await total(pool)).toBe(3);
    expect(publisher.messages).toEqual([{ stream: STREAM, events: res.events }]);
  });

  it('decide sees the current state', async () => {
    const { bus } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 60 }, ctx());
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 50 }, ctx());
    expect(res).toEqual({ ok: false, rejection: { rejected: true, code: 'too_big', message: 'Der Zähler darf 100 nicht überschreiten.' } });
  });

  it('logs denied and rejected commands in access_log, no events', async () => {
    const { pool, bus, publisher } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 1, deny: true }, ctx());
    await bus.execute(incrementHandler, { stream: STREAM, by: 500 }, ctx());
    const log = await pool.query("SELECT action, reason, target, host(ip) AS ip FROM access_log WHERE kind = 'denied' ORDER BY id");
    expect(log.rows).toEqual([
      { action: 'increment', reason: 'forbidden', target: STREAM, ip: '10.0.0.9' },
      { action: 'increment', reason: 'too_big', target: STREAM, ip: '10.0.0.9' },
    ]);
    expect(await readStream(pool, registry, STREAM)).toEqual([]);
    expect(publisher.messages).toEqual([]);
  });

  it('parallel commands keep seq gapless', async () => {
    const { pool, bus } = await setup();
    const results = await Promise.all(Array.from({ length: 20 }, () => bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx())));
    expect(results.every((r) => r.ok)).toBe(true);
    const seqs = (await readStream(pool, registry, STREAM)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await total(pool)).toBe(20);
  });

  it('projection failure rolls back everything', async () => {
    const projections = new ProjectionRegistry();
    projections.register({ name: 'broken', handles: ['counter_incremented'], apply: async () => { throw new Error('kaputt'); }, reset: async () => undefined });
    const { pool, bus, publisher } = await setup({ projections });
    await expect(bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx())).rejects.toThrow('kaputt');
    expect(await readStream(pool, registry, STREAM)).toEqual([]);
    const head = await pool.query('SELECT last_seq FROM stream_heads WHERE stream = $1', [STREAM]);
    expect(head.rows[0]?.last_seq ?? 0).toBe(0);
    expect(publisher.messages).toEqual([]);
  });

  it('creates missing partition and retries', async () => {
    const { pool, bus } = await setup();
    const later = new Date('2031-01-01T00:00:05Z');
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx({ now: later }));
    expect(res.ok).toBe(true);
    const r = await pool.query("SELECT count(*)::int AS n FROM events_y2031m01");
    expect(r.rows[0].n).toBe(1);
  });

  it('push failure does not undo the committed command', async () => {
    const failing: Publisher = { publish: async () => { throw new Error('redis weg'); } };
    const { pool, bus, log } = await setup({ publisher: failing });
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 2 }, ctx());
    expect(res.ok).toBe(true);
    expect(await total(pool)).toBe(2);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('writes snapshots and loads state equal to full replay', async () => {
    const { pool, bus } = await setup({ snapshotEvery: 3 });
    for (let i = 0; i < 7; i++) await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    const snaps = await pool.query('SELECT seq, state FROM snapshots WHERE stream = $1 ORDER BY seq', [STREAM]);
    expect(snaps.rows).toEqual([{ seq: 3, state: { total: 3 } }, { seq: 6, state: { total: 6 } }]);
    const c = await pool.connect();
    try {
      expect(await bus.loadState(c, STREAM, counterReducer)).toEqual({ total: 7 });
    } finally {
      c.release();
    }
    const replay = (await readStream(pool, registry, STREAM)).reduce(counterReducer.apply, counterReducer.initial());
    expect(replay).toEqual({ total: 7 });
  });

  it('runs commands at the fixed test time', async () => {
    const { bus } = await setup();
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    expect(res.ok && res.events[0]!.createdAt).toEqual(AT);
  });
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- command-bus`
Expected: FAIL – `../src/framework/command-bus.js` fehlt.

- [ ] **Step 4: Implementieren**

`packages/server/src/framework/command-bus.ts`:
```ts
import type pg from 'pg';
import { logDenied } from '../audit/access-log.js';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { appendLocked, lockStream, readStream } from '../journal/journal.js';
import { ensurePartitions, isMissingPartition } from '../journal/partitions.js';
import { loadSnapshot, saveSnapshot } from '../journal/snapshots.js';
import type { Actor, EventRecord, NewEvent, StreamId } from '../journal/types.js';
import { isRejection, type Rejection } from '../shared/rejection.js';
import type { ProjectionRegistry } from './projections.js';
import type { Publisher } from './publisher.js';

/** Rein und unveränderlich: apply liefert ein neues Objekt. S muss JSON-serialisierbar sein (Snapshots). */
export interface StreamReducer<S> {
  name: string;
  version: number;
  initial(): S;
  apply(state: S, e: EventRecord): S;
}

export interface CommandContext {
  actor: Actor;
  correlationId: string;
  now: Date;
  ip?: string | null;
}

export interface CommandHandler<C, S, P = undefined> {
  type: string;
  streamOf(cmd: C): StreamId;
  reducer: StreamReducer<S>;
  authorize(cmd: C, ctx: CommandContext): Rejection | null;
  /** Läuft nach der Stromsperre in derselben Transaktion. Für Daten, die nicht im Reducer-Zustand stehen. */
  prepare?(c: pg.PoolClient, cmd: C, ctx: CommandContext): Promise<P>;
  decide(state: S, cmd: C, ctx: CommandContext, prepared: P): NewEvent[] | Rejection;
}

export type CommandResult = { ok: true; events: EventRecord[] } | { ok: false; rejection: Rejection };

export interface BusLogger {
  error(obj: object, msg: string): void;
}

export interface CommandBusDeps {
  pool: pg.Pool;
  registry: EventTypeRegistry;
  projections: ProjectionRegistry;
  publisher: Publisher;
  log: BusLogger;
  snapshotEvery?: number;
}

export const SNAPSHOT_EVERY = 1000;
const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);

export class CommandBus {
  constructor(private readonly d: CommandBusDeps) {}

  async execute<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext): Promise<CommandResult> {
    const denied = h.authorize(cmd, ctx);
    if (denied) return this.deny(h, cmd, ctx, denied);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await withTx(this.d.pool, (c) => this.runOnce(h, cmd, ctx, c));
        if (isRejection(out)) return this.deny(h, cmd, ctx, out);
        await this.publishSafe(h.streamOf(cmd), out);
        return { ok: true, events: out };
      } catch (e) {
        if (attempt === 0 && isMissingPartition(e)) {
          await ensurePartitions(this.d.pool, ctx.now, 2);
          continue;
        }
        if (attempt === 0 && RETRYABLE_SQLSTATE.has((e as { code?: string }).code ?? '')) continue;
        throw e;
      }
    }
  }

  async loadState<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>): Promise<S> {
    const snap = await loadSnapshot<S>(c, stream, reducer);
    let state = snap ? snap.state : reducer.initial();
    for (const e of await readStream(c, this.d.registry, stream, snap?.seq ?? 0)) state = reducer.apply(state, e);
    return state;
  }

  private async runOnce<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext, c: pg.PoolClient): Promise<EventRecord[] | Rejection> {
    const stream = h.streamOf(cmd);
    const lastSeq = await lockStream(c, stream);
    const state = await this.loadState(c, stream, h.reducer);
    const prepared = h.prepare ? await h.prepare(c, cmd, ctx) : (undefined as P);
    const decided = h.decide(state, cmd, ctx, prepared);
    if (isRejection(decided)) return decided;
    const events = await appendLocked(c, this.d.registry, {
      stream, lastSeq, events: decided, actor: ctx.actor, correlationId: ctx.correlationId, at: ctx.now,
    });
    await this.d.projections.applyAll(c, events);
    await this.maybeSnapshot(c, stream, h.reducer, state, events, lastSeq, ctx.now);
    return events;
  }

  private async maybeSnapshot<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>, state: S, events: EventRecord[], lastSeq: number, now: Date) {
    const every = this.d.snapshotEvery ?? SNAPSHOT_EVERY;
    const newSeq = lastSeq + events.length;
    if (Math.floor(lastSeq / every) === Math.floor(newSeq / every)) return;
    const next = events.reduce(reducer.apply, state);
    await saveSnapshot(c, stream, reducer, newSeq, next, now);
  }

  private async deny<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext, rejection: Rejection): Promise<CommandResult> {
    let target: string | null = null;
    try {
      target = h.streamOf(cmd);
    } catch {
      target = null;
    }
    await logDenied(this.d.pool, { actor: ctx.actor, action: h.type, reason: rejection.code, target, ip: ctx.ip ?? null, at: ctx.now });
    return { ok: false, rejection };
  }

  private async publishSafe(stream: StreamId, events: EventRecord[]): Promise<void> {
    try {
      await this.d.publisher.publish(stream, events);
    } catch (err) {
      this.d.log.error({ err, stream }, 'Der Push an die Oberflächen ist fehlgeschlagen. Der Befehl ist gespeichert.');
    }
  }
}
```

Hinweis zur Snapshot-Grenze: Ein Befehl mit mehreren Ereignissen kann über die 1.000er-Grenze springen (z. B. seq 998 → 1003). Der Snapshot steht dann bei 1003. Das ist gewollt: `loadSnapshot` nimmt den neuesten.

- [ ] **Step 5: Tests laufen lassen**

Run: `npm test -w @ccg/server && npm run typecheck && npm run lint`
Expected: PASS, alle Tests grün (9 neue).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/framework/command-bus.ts packages/server/test
git commit -m "feat(framework): Command-Bus mit Stromsperre, Snapshots, Wiederholung und Push"
```

---

### Task 10: Umkehrung (`revert`)

**Files:**
- Create: `packages/server/src/framework/revert.ts`
- Test: `packages/server/test/revert.test.ts`

**Interfaces:**
- Consumes: `CommandHandler`, `StreamReducer`, `CommandContext` (Task 9); `EventTypeRegistry` (Task 5); `readEvent`, `isReverted` (Task 6); `reject`, `isRejection` (Task 5)
- Produces:
  ```ts
  export interface RevertCommand { stream: StreamId; eventId: EventId; reason: string }
  export interface RevertPrepared { target: EventRecord | null; reverted: boolean }
  export const EVENT_VOIDED = 'event_voided';
  export function registerRevertTypes(registry: EventTypeRegistry): void;
  export function makeRevertHandler<S>(reducer: StreamReducer<S>, registry: EventTypeRegistry, authorize: (cmd: RevertCommand, ctx: CommandContext) => Rejection | null): CommandHandler<RevertCommand, S, RevertPrepared>;
  ```

- [ ] **Step 1: Failing test schreiben**

`packages/server/test/revert.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { CommandBus, type CommandHandler } from '../src/framework/command-bus.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { InMemoryPublisher } from '../src/framework/publisher.js';
import { EVENT_VOIDED, makeRevertHandler, registerRevertTypes } from '../src/framework/revert.js';
import { readStream } from '../src/journal/journal.js';
import { reject } from '../src/shared/rejection.js';
import { freshDb } from './helpers/db.js';
import { OTHER_STREAM, STREAM, counterReducer, ctx, incrementHandler, testRegistry, type CounterState } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const registry = testRegistry();
registerRevertTypes(registry);

const allow = () => null;
const revert = makeRevertHandler(counterReducer, registry, allow);

function emit(type: string, payload: unknown, reason?: string): CommandHandler<{ stream: string }, CounterState> {
  return { type: `emit_${type}`, streamOf: (c) => c.stream, reducer: counterReducer, authorize: allow, decide: () => [{ type, payload, reason }] };
}

async function setup() {
  const db = await freshDb();
  close = db.close;
  const bus = new CommandBus({ pool: db.pool, registry, projections: new ProjectionRegistry(), publisher: new InMemoryPublisher(), log: { error: () => undefined } });
  return { pool: db.pool, bus };
}

async function firstId(bus: CommandBus, h: CommandHandler<{ stream: string }, CounterState>, stream = STREAM) {
  const r = await bus.execute(h, { stream }, ctx());
  if (!r.ok) throw new Error('setup failed');
  return r.events[0]!.id;
}

describe('revert', () => {
  it('compensate writes the inverse event with reason and link', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    const id = r1.ok ? r1.events[0]!.id : '';
    const res = await bus.execute(revert, { stream: STREAM, eventId: id, reason: 'Falscher Kanal' }, ctx());
    expect(res.ok).toBe(true);
    const events = await readStream(pool, registry, STREAM);
    expect(events[1]).toMatchObject({ type: 'counter_decremented', payload: { by: 4 }, reason: 'Falscher Kanal', reversesEventId: id });
    expect(events.reduce(counterReducer.apply, counterReducer.initial())).toEqual({ total: 0 });
  });

  it('a reversal can itself be reverted', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    const r2 = await bus.execute(revert, { stream: STREAM, eventId: r1.ok ? r1.events[0]!.id : '', reason: 'a' }, ctx());
    const r3 = await bus.execute(revert, { stream: STREAM, eventId: r2.ok ? r2.events[0]!.id : '', reason: 'b' }, ctx());
    expect(r3.ok).toBe(true);
    expect((await readStream(pool, registry, STREAM)).reduce(counterReducer.apply, counterReducer.initial())).toEqual({ total: 4 });
  });

  it('void writes event_voided', async () => {
    const { pool, bus } = await setup();
    const id = await firstId(bus, emit('thing_drawn', { winner: '44444444-4444-4444-8444-444444444444' }));
    const res = await bus.execute(revert, { stream: STREAM, eventId: id, reason: 'Gewinner meldet sich nicht' }, ctx());
    expect(res.ok).toBe(true);
    const last = (await readStream(pool, registry, STREAM)).at(-1)!;
    expect(last).toMatchObject({ type: EVENT_VOIDED, payload: { targetType: 'thing_drawn' }, reversesEventId: id });
  });

  it('rejects: none, twice, unknown, foreign stream, missing reason', async () => {
    const { pool, bus } = await setup();
    const note = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }));
    const inc = (await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx()));
    const incId = inc.ok ? inc.events[0]!.id : '';
    const foreign = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }), OTHER_STREAM);
    await bus.execute(revert, { stream: STREAM, eventId: incId, reason: 'ok' }, ctx());
    const codes = [];
    for (const cmd of [
      { eventId: note, reason: 'r' },
      { eventId: incId, reason: 'r' },
      { eventId: '987654', reason: 'r' },
      { eventId: foreign, reason: 'r' },
      { eventId: incId, reason: '  ' },
    ]) {
      const r = await bus.execute(revert, { stream: STREAM, ...cmd }, ctx());
      codes.push(r.ok ? 'ok' : r.rejection.code);
    }
    expect(codes).toEqual(['not_reversible', 'already_reverted', 'event_not_found', 'event_not_found', 'reason_required']);
    const before = (await readStream(pool, registry, STREAM)).length;
    expect(before).toBe(3);
  });

  it('none rejection carries the reason text from the event type', async () => {
    const { bus } = await setup();
    const note = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }));
    const r = await bus.execute(revert, { stream: STREAM, eventId: note, reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.message).toBe('Eine gesendete Chatnachricht lässt sich nicht zurückholen.');
  });

  it('inverse may reject based on current state', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    await bus.execute(emit('counter_corrected', { to: 1 }, 'Zählfehler'), { stream: STREAM }, ctx());
    const r = await bus.execute(revert, { stream: STREAM, eventId: r1.ok ? r1.events[0]!.id : '', reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.code).toBe('would_go_negative');
    expect(r.ok ? '' : r.rejection.message).toBe('Der Zähler würde negativ. Nimm zuerst die späteren Einträge zurück.');
    expect(await readStream(pool, registry, STREAM)).toHaveLength(2);
  });

  it('authorize is applied', async () => {
    const { bus } = await setup();
    const denyAll = makeRevertHandler(counterReducer, registry, () => reject('forbidden', 'Du darfst nichts zurücknehmen.'));
    const r = await bus.execute(denyAll, { stream: STREAM, eventId: '1', reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.code).toBe('forbidden');
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- revert`
Expected: FAIL – `../src/framework/revert.js` fehlt.

- [ ] **Step 3: Implementieren**

`packages/server/src/framework/revert.ts`:
```ts
import { z } from 'zod';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { isReverted, readEvent } from '../journal/journal.js';
import type { EventId, EventRecord, StreamId } from '../journal/types.js';
import { isRejection, reject, type Rejection } from '../shared/rejection.js';
import type { CommandContext, CommandHandler, StreamReducer } from './command-bus.js';

export interface RevertCommand {
  stream: StreamId;
  eventId: EventId;
  reason: string;
}

export interface RevertPrepared {
  target: EventRecord | null;
  reverted: boolean;
}

export const EVENT_VOIDED = 'event_voided';

export function registerRevertTypes(registry: EventTypeRegistry): void {
  registry.register({
    type: EVENT_VOIDED,
    version: 1,
    schema: z.object({ targetType: z.string() }),
    requiresReason: true,
    reversal: { kind: 'none', why: 'Ein ungültiger Eintrag bleibt ungültig. Für ein neues Ergebnis führe die Aktion neu aus.' },
  });
}

export function makeRevertHandler<S>(
  reducer: StreamReducer<S>,
  registry: EventTypeRegistry,
  authorize: (cmd: RevertCommand, ctx: CommandContext) => Rejection | null,
): CommandHandler<RevertCommand, S, RevertPrepared> {
  return {
    type: 'revert',
    streamOf: (cmd) => cmd.stream,
    reducer,
    authorize,
    async prepare(c, cmd) {
      const target = await readEvent(c, registry, cmd.eventId);
      const reverted = target ? await isReverted(c, cmd.eventId) : false;
      return { target, reverted };
    },
    decide(state, cmd, _ctx, { target, reverted }) {
      if (!cmd.reason?.trim()) return reject('reason_required', 'Gib einen Grund für die Umkehrung an.');
      if (!target || target.stream !== cmd.stream) return reject('event_not_found', 'Diesen Eintrag gibt es in diesem Verlauf nicht.');
      if (reverted) return reject('already_reverted', 'Dieser Eintrag ist schon aufgehoben.');
      const spec = registry.get(target.type).reversal;
      if (spec.kind === 'none') return reject('not_reversible', spec.why);
      if (spec.kind === 'void') {
        return [{ type: EVENT_VOIDED, payload: { targetType: target.type }, reason: cmd.reason, reversesEventId: target.id }];
      }
      const inverse = spec.inverse(target, state);
      if (isRejection(inverse)) return inverse;
      return [{ ...inverse, reason: cmd.reason, reversesEventId: target.id }];
    },
  };
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -w @ccg/server -- revert && npm run typecheck`
Expected: PASS, 7 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/framework/revert.ts packages/server/test/revert.test.ts
git commit -m "feat(framework): Umkehrung per compensate, void und none"
```

---

### Task 11: Prozesse `app` und `scheduler`, Entwicklungs-Compose

**Files:**
- Create: `packages/server/src/app/build-app.ts`, `src/app/main.ts`, `src/scheduler/maintenance.ts`, `src/scheduler/main.ts`, `docker-compose.dev.yml`
- Test: `packages/server/test/app.test.ts`, `packages/server/test/maintenance.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError` (Task 3); `createPool` (Task 4); `runMigrations` (Task 4); `ensurePartitions` (Task 6); `purgeIps` (Task 7)
- Produces:
  ```ts
  export function buildApp(deps: { pool: pg.Pool }): FastifyInstance; // GET /healthz
  export function runMaintenance(pool: pg.Pool, now: Date): Promise<{ partitions: string[]; ipsPurged: number }>;
  ```

- [ ] **Step 1: Failing tests schreiben**

`packages/server/test/app.test.ts`:
```ts
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app/build-app.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('GET /healthz', () => {
  it('returns ok when the database answers', async () => {
    const db = await freshDb();
    close = db.close;
    const res = await buildApp({ pool: db.pool }).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 with a German reason when the database is gone', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    close = () => pool.end();
    const res = await buildApp({ pool }).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', reason: 'Die Datenbank antwortet nicht.' });
  });
});
```

`packages/server/test/maintenance.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { logRead } from '../src/audit/access-log.js';
import { runMaintenance } from '../src/scheduler/maintenance.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('runMaintenance', () => {
  it('creates upcoming partitions and purges old IPs', async () => {
    const db = await freshDb();
    close = db.close;
    await logRead(db.pool, { actor: ACTOR, action: 'a', target: 't', ip: '10.0.0.1', at: AT });
    const later = new Date(AT.getTime() + 40 * 86_400_000);
    const res = await runMaintenance(db.pool, later);
    expect(res).toEqual({ partitions: ['events_y2026m11', 'events_y2026m12', 'events_y2027m01'], ipsPurged: 1 });
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `npm test -w @ccg/server -- app maintenance`
Expected: FAIL – Module fehlen.

- [ ] **Step 3: Implementieren**

`packages/server/src/app/build-app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export function buildApp(deps: { pool: pg.Pool }, opts: { logger?: boolean | object } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error', reason: 'Die Datenbank antwortet nicht.' });
    }
  });
  return app;
}
```

`packages/server/src/app/main.ts`:
```ts
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { ensurePartitions } from '../journal/partitions.js';
import { buildApp } from './build-app.js';

async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  await ensurePartitions(pool, new Date(), 2);
  const app = buildApp({ pool }, { logger: { level: config.logLevel } });
  await app.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
```

`packages/server/src/scheduler/maintenance.ts`:
```ts
import type pg from 'pg';
import { purgeIps } from '../audit/access-log.js';
import { ensurePartitions } from '../journal/partitions.js';

export async function runMaintenance(pool: pg.Pool, now: Date): Promise<{ partitions: string[]; ipsPurged: number }> {
  const partitions = await ensurePartitions(pool, now, 2);
  const ipsPurged = await purgeIps(pool, now);
  return { partitions, ipsPurged };
}
```

`packages/server/src/scheduler/main.ts`:
```ts
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { runMaintenance } from './maintenance.js';

const HOUR_MS = 60 * 60 * 1000;

/** Genau eine Instanz dieses Prozesses darf laufen (NEW_DESIGN.md 3.1). */
async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const tick = async () => {
    try {
      const r = await runMaintenance(pool, new Date());
      console.log(JSON.stringify({ msg: 'Wartung erledigt', ...r }));
    } catch (e) {
      console.error(JSON.stringify({ msg: 'Wartung fehlgeschlagen. Nächster Versuch in einer Stunde.', err: String(e) }));
    }
  };
  await tick();
  setInterval(tick, HOUR_MS);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
```

`docker-compose.dev.yml` (Repo-Root):
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ccg
      POSTGRES_PASSWORD: ccg
      POSTGRES_DB: ccg
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6380:6379"
volumes:
  pgdata:
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test -w @ccg/server -- app maintenance`
Expected: PASS, 3 Tests grün.

- [ ] **Step 5: Gesamtprüfung und Start-Probe**

Run:
```bash
npm run typecheck && npm run lint && npm test && npm run build
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
set -a; . ./.env; set +a
node packages/server/dist/app/main.js &
sleep 2; curl -s localhost:3000/healthz; kill %1
DATABASE_URL= node packages/server/dist/app/main.js; echo "exit=$?"
```
Expected: alle Prüfungen grün; `{"status":"ok"}`; der letzte Start bricht mit „Der Start ist abgebrochen …“ und `DATABASE_URL: …` ab, `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Prozesse app und scheduler, Healthcheck, Wartung, Dev-Compose"
```

---

## Nach diesem Plan

Teilprojekt 2 (Kern-Vertrag + Kern B) baut darauf auf: `kernel-api`, Kern-Registry, Giveaway-Lebenszyklus als `StreamReducer`, Ziehung. Neue Ereignistypen registrieren sich in der `EventTypeRegistry`, neue Befehle sind `CommandHandler`, neue Lesetabellen sind `Projector`.
