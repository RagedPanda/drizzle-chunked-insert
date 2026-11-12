# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `insertInChunks(db, table, rows)` inserts any number of rows in as few statements as the driver's bound-parameter and statement-length limits allow, and all-or-nothing by default: one transaction, or one `db.batch` on D1, libsql and neon-http. Called with a transaction, it runs inside it. Pass `atomic: false` to commit chunk by chunk; a failure then throws `ChunkedInsertError` with the rows already inserted, so you can resume.
- `insertInChunks(db, rows, (db, chunk) => query)` builds each chunk's query yourself, for upserts and `returning()`; the returned rows come back in input order and typed like drizzle's own.
- `planChunks` returns the chunks without running anything, and `maxParams`, `maxSqlLength` and `maxRows` override the detected limits. A row too large to fit on its own throws `RowTooLargeError` before anything runs.

[Unreleased]: https://github.com/RagedPanda/drizzle-chunked-insert/commits/main
