# drizzle-chunked-insert

Insert any number of rows with [Drizzle ORM](https://orm.drizzle.team) without hitting your database's bound-parameter limit. It splits the rows into the fewest statements each driver allows (Cloudflare D1, SQLite, Postgres, MySQL) and writes them all or none.

```ts
import {insertInChunks} from 'drizzle-chunked-insert';

await insertInChunks(db, users, rows); // 10 rows or 10 million
```

Works on drizzle-orm 0.36, 0.45 and 1.0.

## The problem

`db.insert(table).values(rows)` turns every value into a bound parameter, and every database caps how many parameters one statement may carry. Below the cap it works. One row over, and it fails:

| Driver | Limit per statement | What you get above it |
| --- | --- | --- |
| Cloudflare D1, Durable Objects | 100 parameters, 100,000 bytes of SQL | `too many SQL variables at offset ...` ([drizzle-orm#2479](https://github.com/drizzle-team/drizzle-orm/issues/2479)) |
| better-sqlite3, libsql, node:sqlite | 32,766 parameters | `too many SQL variables` |
| Postgres (node-postgres, PGlite, ...) | 65,535 parameters | `bind message supplies 0 parameters, but prepared statement requires ...`, because the count wraps around |
| postgres.js | 65,533 parameters | `MAX_PARAMETERS_EXCEEDED` |
| MySQL (mysql2) | the server's `max_allowed_packet` | drizzle's mysql2 driver fills values in client-side, so one huge statement fails on size instead |

On D1, 100 parameters is just 25 rows of a four-column table. Before drizzle 1.0, very large arrays also overflow the call stack while building the SQL ([drizzle-orm#1740](https://github.com/drizzle-team/drizzle-orm/issues/1740)).

The usual fix is a loop over fixed-size slices:

```ts
for (const part of chunk(rows, 1000)) {
	await db.insert(users).values(part);
}
```

It breaks in quiet ways:

- **The right size depends on the driver and the table.** 1,000 rows is too many on D1 and far too few on Postgres. Add a column and a size that worked before starts failing.
- **Rows don't all cost the same.** Optional columns left out, `$defaultFn` and `sql` values change how many parameters a row takes, so a fixed row count can still overflow.
- **A failure halfway leaves half the rows in.** Without a transaction, chunk 7 failing keeps chunks 1 to 6. D1 has no interactive transactions at all; it needs `db.batch`.
- **`returning()` and upserts** need their results stitched back together in order.

This library does all of that for you. It detects the driver's limits, sizes every chunk to the largest that fits, and runs them in one transaction, or one `db.batch` where the driver needs it.

## Install

```sh
npm install drizzle-chunked-insert
```

`drizzle-orm` 0.36.4 or later is a peer dependency. There are no runtime dependencies.

## Usage

### Insert rows

```ts
import {insertInChunks} from 'drizzle-chunked-insert';

await insertInChunks(db, users, rows);
```

Either every row goes in or none does. If any chunk fails, the chunks before it are rolled back and the driver's error is thrown.

### Upserts and `returning()`

Pass a function that builds one chunk's query instead of the table. Build it on the `db` you are handed, which is the transaction when the insert is atomic:

```ts
const saved = await insertInChunks(db, rows, (db, chunk) =>
	db.insert(users)
		.values(chunk)
		.onConflictDoUpdate({target: users.id, set: {name: sql`excluded.name`}})
		.returning({id: users.id}),
);
// saved: {id: number}[], in input order, across all chunks
```

The returned rows are typed the same way drizzle types them. A statement-wide cost like the `set` clause is measured too, so chunks shrink by a row or two, not by half.

### Cloudflare D1

D1 needs nothing special:

```ts
await insertInChunks(drizzle(env.DB), events, rows);
```

Chunks stay under 100 parameters and 100,000 bytes, and they run as one `db.batch`, so they commit or fail together.

### Inside your own transaction

```ts
await db.transaction(async tx => {
	await tx.insert(imports).values({id});
	await insertInChunks(tx, importRows, rows);
});
```

Given a transaction, it runs the chunks inside it, and they commit or roll back with the rest of your work.

### Commit chunk by chunk and resume

For very large loads where redoing everything after a failure costs too much, pass `atomic: false`. Each chunk commits on its own. A failure throws `ChunkedInsertError` saying how far it got:

```ts
import {ChunkedInsertError, insertInChunks} from 'drizzle-chunked-insert';

try {
	await insertInChunks(db, users, rows, {atomic: false});
} catch (error) {
	if (error instanceof ChunkedInsertError) {
		// rows.slice(0, error.insertedRows) are in; fix the cause, then resume:
		await insertInChunks(db, users, rows.slice(error.insertedRows), {atomic: false});
	}
}
```

### See the chunks without inserting

```ts
import {planChunks} from 'drizzle-chunked-insert';

planChunks(db, users, rows).map(chunk => chunk.length);
// [16383, 16383, 7234] for 40,000 two-column rows on better-sqlite3
```

## API

### `insertInChunks(db, table, rows, options?)`

Inserts `rows` into `table` and resolves when every chunk has run. `db` is a drizzle database or transaction.

### `insertInChunks(db, rows, build, options?)`

Calls `build(db, chunk)` for each chunk and runs the query it returns. Resolves to every chunk's `returning()` rows in input order when the query has `returning()`, or to nothing otherwise.

### `planChunks(db, table, rows, options?)` / `planChunks(db, rows, build, options?)`

Returns the chunks (arrays of your rows) that `insertInChunks` would run, without running anything.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxParams` | the driver's limit | Most bound parameters per statement. |
| `maxSqlLength` | D1's 100,000 bytes; none elsewhere | Longest statement in bytes. |
| `maxRows` | none | Most rows per chunk, if you want smaller statements than the limits allow. |
| `atomic` | `true` | `insertInChunks` only. All rows or none. `false` commits each chunk on its own. |

A limit that isn't a positive whole number throws a `RangeError` naming the option, before anything runs.

### Errors

- **`ChunkedInsertError`** is thrown with `atomic: false` when a chunk fails. `insertedRows` is how many rows went in before the failed chunk; they stay inserted. `failedChunk` is the failed chunk's index. `cause` is the driver's error.
- **`RowTooLargeError`** is thrown before anything runs when one row needs more than the limit by itself. It has `rowIndex`, `size` and `limits`.

With `atomic` left on, a failed chunk rolls everything back and the driver's own error is thrown.

### Detected limits

| Driver | `maxParams` | `maxSqlLength` | Runs chunks in |
| --- | --- | --- | --- |
| D1, Durable Objects | 100 | 100,000 | `db.batch` (D1), a transaction (Durable Objects) |
| better-sqlite3, libsql, node:sqlite | 32,766 | | a transaction; `db.batch` on libsql |
| node-postgres, PGlite, neon and other Postgres drivers | 65,535 | | a transaction; `db.batch` on neon-http |
| postgres.js | 65,533 | | a transaction |
| mysql2 and other MySQL drivers | 65,535, MySQL's limit for prepared statements | | a transaction |
| other SQLite drivers (sql.js, bun:sqlite, expo, op-sqlite, ...) | 999 | | a transaction |

The other SQLite drivers get 999, SQLite's limit before 3.32, because their bundled SQLite version isn't known. Pass `maxParams: 32_766` if yours is newer.

## Benchmark

Apple M5 (10 cores), Node v24.17.0, macOS (Darwin 27.0.0), drizzle-orm 0.45.4:

| Driver (rows) | single `values()` | one row per statement | fixed 1,000-row chunks | `insertInChunks` |
| --- | --- | --- | --- | --- |
| better-sqlite3 (100,000) | fails: maximum call stack size exceeded | 1,112 ms | 371 ms | 392 ms |
| libsql (100,000) | fails: maximum call stack size exceeded | 1,439 ms | 386 ms | 409 ms |
| PGlite (100,000) | fails: maximum call stack size exceeded | 8,223 ms | 1,207 ms | 1,299 ms |
| D1 via Miniflare (10,000) | fails: `statement too long` | not run, about 10 ms per row | fails: `too many SQL variables` | 1,915 ms |

Run it yourself with `npm run bench` (`RUNS` and `ROWS` change the defaults). Each run gets a fresh in-memory database and inserts 4-column rows. The numbers are the median of 10 runs after one warm-up. D1 runs through Miniflare, where every statement is a round trip to workerd, so it inserts 10,000 rows.

- **single `values()`** is drizzle's plain `insert(table).values(rows)`. It fails on every driver at this size.
- **one row per statement** loops over the rows inside a transaction.
- **fixed 1,000-row chunks** is the usual hand-rolled loop inside a transaction, or one `db.batch` on D1.
- **`insertInChunks`** is this library.

[`@trovohealth/drizzle-bulk-load`](https://www.npmjs.com/package/@trovohealth/drizzle-bulk-load), the closest library, isn't in the table because it needs a Postgres server reached through node-postgres or postgres.js. For large Postgres loads, its `COPY` approach is the faster one.

`insertInChunks` comes within 5 to 8% of hand-tuned fixed chunks, and the same call works everywhere. A fixed size that suits SQLite fails on D1, where only `insertInChunks` finished.

## Good to know

- **How chunks are sized.** For `insertInChunks(db, table, rows)` with plain values, it counts parameters per row without compiling anything, then checks the count by compiling the first 100 rows once. It falls back to compiling and measuring chunks in these cases:
  - values are `sql` or other drizzle objects,
  - the table has a custom column type,
  - on D1, because of its length limit,
  - for the `build` form.

  That fallback costs about one extra compile per chunk.
- **`$defaultFn` may run more than once per row** when chunks are measured, because drizzle calls it each time a query is built. The values inserted come from the statement that ran. Avoid `$defaultFn`s with side effects.
- **D1 has no interactive transactions.** All-or-nothing on D1 means one `db.batch`, which D1 runs as a single transaction. Given a D1 database, the library uses it automatically.
- **MySQL's `max_allowed_packet`** limits the size of one statement in bytes, and the library doesn't detect it. If rows with large text or blob values hit it, pass `maxRows` or `maxSqlLength`.
- **Tested drivers:** better-sqlite3, libsql, node:sqlite, PGlite, node-postgres, postgres.js, mysql2 and D1 (via Miniflare), on drizzle-orm 0.36.4, 0.45.4 and 1.0.0-rc.5. neon-http and the other drivers are detected by drizzle's class names but aren't tested against a real server.
- **Rows of different shapes are fine.** Rows that leave out different optional columns are sized by what each row binds.
- **Performance cost.** `insertInChunks` uses drizzle's query builder for every chunk, so it costs what drizzle costs. For millions of rows into Postgres, a `COPY` loader such as [`@trovohealth/drizzle-bulk-load`](https://www.npmjs.com/package/@trovohealth/drizzle-bulk-load) is faster.

## Related libraries

- [`@trovohealth/drizzle-bulk-load`](https://www.npmjs.com/package/@trovohealth/drizzle-bulk-load) loads rows into Postgres with `COPY` through a temporary table, with inserts, updates and upserts. It is the faster choice for very large Postgres loads, but supports only node-postgres and postgres.js.
- [`lodash.chunk`](https://www.npmjs.com/package/lodash.chunk) and similar helpers split arrays into fixed-size slices. That is the loop above, with the problems listed there.

## License

MIT
