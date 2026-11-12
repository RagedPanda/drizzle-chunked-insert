---
title: drizzle-chunked-insert - Plan
type: feat
date: 2026-11-12
execution: code
---

# drizzle-chunked-insert - Plan

**Target repo:** `~/projects/OS/drizzle-chunked-insert` (new; GitHub `RagedPanda/drizzle-chunked-insert`, npm `drizzle-chunked-insert`, both names free on 2026-11-12). Paths are relative to it unless prefixed with `drizzle-sqlite-fts/`, the sibling repo whose tooling we copy.

---

## Goal Capsule

- **Objective:** a Drizzle user can insert any number of rows with one call, on any dialect and driver, without hitting the database's bound-parameter limit, without picking a batch size by hand, and with all-or-nothing behaviour by default.
- **Means:** a small runtime library. It splits the rows into chunks that each fit the driver's limits, measured against the SQL Drizzle actually compiles, then runs the chunks inside a transaction, or a `db.batch` on drivers without interactive transactions.
- **Authority:** this plan's Requirements win on behaviour, KTDs on mechanism, and `~/projects/OS/CLAUDE.md` and `~/.claude/CLAUDE.md` on repo, commit and release conventions.
- **Execution profile:** one logical commit per PR, squash-merged, in the unit order below. Same gates as drizzle-sqlite-fts: CI matrix, 100% coverage, attw, release through `release.yml` with npm trusted publishing.
- **Who finishes:** creating the repo, pushes and merges follow the same approval as drizzle-sqlite-fts. The owner (or an agent with explicit permission) pushes release tags. npm trusted publishing is set up after the first publish, as with drizzle-sqlite-fts.
- **Stop conditions:** stop and report if Miniflare's D1 does not enforce the production 100-parameter limit and no other local D1 runtime does, or if one of the supported drizzle-orm versions doesn't expose what we need to tell which driver a `db` uses or whether it is already a transaction.

---

## Product Contract

### Problem Frame

`db.insert(table).values(rows)` compiles to one statement with a bound parameter for almost every value. Every database caps that:

| Target | Limit (to verify in U1) |
|---|---|
| Cloudflare D1 | 100 bound parameters per query; 100 KB statement length |
| SQLite (better-sqlite3, libsql, bun:sqlite, node:sqlite) | `SQLITE_MAX_VARIABLE_NUMBER`, 32,766 by default since 3.32 |
| Postgres (node-postgres, postgres.js, PGlite, Neon) | 65,535 (the wire protocol's 16-bit parameter count) |
| MySQL (mysql2) | 65,535 placeholders for prepared statements; `max_allowed_packet` for client-side interpolation |

Past those limits users see `too many SQL variables` (drizzle-orm#2479, 38 reactions, open since 2024), `MAX_PARAMETERS_EXCEEDED` or `Maximum call stack size exceeded` (drizzle-orm#1740, 40 reactions). Drizzle doesn't chunk, unlike Prisma's `createMany` or knex's `batchInsert`.

The threads pass around workarounds like `for (const part of chunk(rows, 100)) await db.insert(t).values(part)`. They break in three ways:

1. **The batch size is a guess.** Probing drizzle-orm 0.45.4 on 2026-11-12 showed that parameters per row are not the column count:
   - SQLite inlines a missing value as `null`, but a column with `.default()` or `$defaultFn` becomes a bound parameter.
   - Postgres and MySQL inline a missing value as `default`.
   - Two rows of the same table took 3 and 4 parameters.
   - An `onConflictDoUpdate` `set` adds parameters once per statement.
   - A `sql` value can add several parameters to one column.

   On D1 a table with 11 columns overflows a batch of 10 rows.
2. **They aren't atomic.** A failure in chunk 7 leaves chunks 1-6 committed. On D1 and neon-http, drizzle has no interactive transaction to wrap them in (drizzle-orm#2463).
3. **They drop `returning()` and upsert clauses**, or every caller re-implements merging them.

### Key Decisions (proposed; confirm before U1)

- **Name: `drizzle-chunked-insert`.** Says what it does and fits drizzle-triggers / drizzle-sqlite-fts.
- **Inserts only in 0.1.** The same parameter limit hits `inArray(col, ids)` with thousands of ids in selects, updates and deletes. That is a different API, so it's deferred (see Scope Boundaries).
- **Same drizzle-orm range as the siblings: 0.36, 0.45, 1.0 rc**, all three dialects.
- **No runtime dependencies.** `drizzle-orm` is the only peer dependency.

### Requirements

**API**

- R1. `insertInChunks(db, table, rows)` inserts every row and resolves once all are written.
- R2. For upserts and returning, a second form takes a build callback that builds each chunk's query on the `db` it is handed (the transaction, when atomic): `insertInChunks(db, rows, (db, chunk) => db.insert(users).values(chunk).onConflictDoNothing().returning({id: users.id}))`. With `returning`, the result is every chunk's returned rows concatenated in input order, typed like Drizzle's own `returning()`. (Changed in U3: a `modify(q => ...)` callback can't be typed across versions, since `returning()` came back as `{[x: string]: unknown}[]`.)
- R3. Options: `atomic` (default `true`); `maxParams` and `maxSqlLength` overrides; `maxRows` per chunk (an upper bound, for users who want smaller statements).
- R4. `planChunks(db, table, rows, options?)` and `planChunks(db, rows, build, options?)` return the chunks as arrays without running anything, for callers who batch the queries themselves.
- R5. Zero rows is a no-op that returns `[]`, not Drizzle's "values() must be called with at least one value" error.

**Correctness**

- R6. No chunk ever exceeds the target's parameter limit or statement length. This holds for mixed rows, defaults, `$defaultFn`, `sql` values, custom types and upsert `set` clauses, because the check runs on the compiled statement (KTD2).
- R7. A single row that can't fit even alone fails before anything runs, with an error naming the row index, its parameter count and the limit.
- R8. With `atomic: true` (the default), either every row is inserted or none is. Async drivers use `db.transaction`. better-sqlite3, bun:sqlite and node:sqlite use a synchronous transaction. D1, neon-http and libsql use `db.batch` (KTD3).
- R9. Called with a transaction (`tx`) instead of `db`, it runs the chunks in that transaction without nesting a new one.
- R10. With `atomic: false`, a failure throws `ChunkedInsertError`. The error's `cause` is the driver error, `insertedRows` is the number of rows already committed, and `failedChunk` is the failed chunk's index, so the caller can resume.

**Performance**

- R11. The chunk size is chosen per target, near the maximum the limits allow, not a fixed 100. Planning overhead is benchmarked and documented (KTD2).

### Scope Boundaries

- Not in 0.1: chunked `inArray` for select/update/delete, parallel chunk execution, streaming/async-iterable input, `COPY`/`LOAD DATA` fast paths.
- No changes to drizzle-orm. If upstream later chunks inserts itself, the README says so and points to it.

---

## Key Technical Decisions

- **KTD1. Estimate, then verify on the compiled SQL.** Reimplementing Drizzle's value-to-parameter mapping would drift across 0.36, 0.45 and 1.0. Instead:
  - The estimate is one parameter per table column per row. That is an upper bound for plain values, since `null` and `default` literals take fewer.
  - A `sql` value or a custom type that returns SQL is counted as unknown.
  - Chunks are built greedily under the limit from the estimate.
  - Each chunk is then compiled once with `.toSQL()` and its real parameter count and SQL length are checked.
  - A chunk over a limit is split in half and checked again.
  - Only the compiled count is trusted, so R6 holds even when the estimate is wrong.
- **KTD2. Measure the planning cost; don't assume it.** The check compiles every row once more on top of Drizzle's own compile at execution. The benchmark reports planning time separately. If planning takes more than about 15% of total time on SQLite in memory, U3 must reuse the compiled query through Drizzle's prepared-query path instead of compiling twice.
- **KTD3. Detect the driver from the session's `entityKind`**, the same mechanism `is()` uses. The detected driver sets the limits (Problem Frame table) and the atomic strategy:
  - batch: D1, libsql, neon-http
  - synchronous transaction: better-sqlite3, bun, node:sqlite
  - async transaction: everything else
  - An unknown driver falls back to its dialect's defaults, and `maxParams` overrides the limit.
  - U1 verifies the session class names on all three drizzle-orm versions.
- **KTD4. A transaction is detected structurally, by `typeof db.rollback === 'function'`.** drizzle 1.0 renamed the transaction classes, so `is()` checks don't work across versions. No D1 `tx` check is needed: drizzle's D1 `transaction()` already fails at `begin`.
- **KTD5. Pure core, I/O at the edges.**
  - `src/plan.ts`: pure chunking over row costs and limits.
  - `src/limits.ts`: driver to limits and strategy.
  - `src/run.ts`: executes the chunks.
  - `src/index.ts`: the public API.
  - The pure modules get unit tests; `run.ts` gets driver integration tests.

---

## Implementation Units

Each unit is one PR with one logical commit, merged only after `gh pr checks N` shows no `fail`.

- **U0. Scaffold.** Copy drizzle-sqlite-fts's build (ESM + CJS + types), `node --test` coverage, attw, CI matrix, `release.yml` (OIDC-only, `npm ci --ignore-scripts`), `scripts/release-notes.ts`, CHANGELOG and ruleset "Protect main". Peer dependency: `drizzle-orm >=0.36.4`.
- **U1. Verify the facts the design rests on, as tests.**
  - The real limits per driver: insert at limit and at limit+1 and assert where the error starts.
  - Whether Miniflare's D1 enforces 100 parameters and 100 KB (stop condition).
  - Whether a multi-row `VALUES` in SQLite is capped by `SQLITE_LIMIT_COMPOUND_SELECT`.
  - The row count where #1740's call-stack error starts.
  - The session `entityKind` names on 0.36, 0.45 and 1.0-rc.
  - Results go into `src/limits.ts` and the README.
- **U2. `plan.ts`:** greedy chunking, split-on-overflow, R5 and R7. Property tests check that random row shapes never produce a chunk over the limit and keep the input order.
- **U3. `limits.ts` + `run.ts` + `insertInChunks` / `planChunks`:** R1-R4 and R8-R10, with types that follow the build callback's `returning()`.
- **U4. Integration matrix:**
  - Drivers: better-sqlite3, libsql (file), node:sqlite, D1 (Miniflare), PGlite, node-postgres and postgres.js (CI service), mysql2 (CI service).
  - drizzle-orm: 0.36, 0.45 and 1.0-rc.
  - Every test inserts past the limit, checks atomic rollback on a failing row, checks `returning` order, and runs inside a caller's `tx`.
- **U5. Benchmark** (`bench/`, rerunnable):
  - Rows: 100k rows on better-sqlite3 and PGlite, 10k on D1/Miniflare.
  - Compared approaches:
    1. one big insert (shows where it fails)
    2. a row-at-a-time loop
    3. the threads' fixed-chunk workaround
    4. knex `batchInsert`
    5. `insertInChunks`
  - Reported: rows/s, planning time (KTD2) and the chunk size chosen.
- **U6. README** following the OS checklist:
  - the problem with the #2479/#1740 errors
  - why fixed batch sizes fail, with the probe output
  - install and usage: plain, upsert, returning, D1, inside a transaction, `atomic: false` resume
  - the full API, benchmarks and the machine they ran on
  - "Good to know": limits table, D1 batch caveats, MySQL `max_allowed_packet`
  - related: knex `batchInsert`, Prisma `createMany`
  - badges like drizzle-sqlite-fts
  - a test that runs the README examples
- **U7. Release 0.1.0** (CHANGELOG section, version bump, signed tag).

---

## Verification

- `npm test` and coverage are at 100%. attw reports nothing. The CI matrix is green on Linux/macOS/Windows × Node 22/24 and on all three drizzle-orm versions.
- For every driver in U4, a test inserts limit × 3 rows, then asserts all rows exist and that no chunk the planner made exceeds the limit.
- An atomic test inserts rows where one late row violates a constraint, then asserts the table is empty afterwards. A second test does the same with `atomic: false` and asserts `insertedRows`.
- The benchmark numbers in the README come from one recorded run, with the command to reproduce them.

## Risks

- **D1 locally vs in production.** If Miniflare's limits differ from production, the README states which limits were verified where.
- **Prepared-statement drivers count parameters differently from `toSQL()`** (for example mysql2 `query` vs `execute`). U1's limit-edge tests catch this per driver.
- **drizzle-orm 1.0 renames internals** that KTD3 and KTD4 rely on. The matrix runs 1.0-rc, and the `entityKind` names live in one table in `limits.ts`.
- **Upstream may fix #2479.** Both issues have been open since 2024. Before U0, check the 1.0-rc changelog and both threads again. As of 2026-11-12 there is no open drizzle-orm PR that chunks inserts. Two open PRs, #3816 and #5996 ("Fix RangeError in mergeQueries for large batch inserts"), only target #1740's call-stack error. If they merge, that error goes away, but the parameter limits stay, so the README should lead with the parameter limit and not with #1740.
