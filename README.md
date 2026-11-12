# drizzle-chunked-insert

Insert any number of rows with [Drizzle ORM](https://orm.drizzle.team). It splits the rows into statements that fit each driver's bound-parameter limit (Cloudflare D1, SQLite, Postgres, MySQL) and writes them all or none, so a large `insert().values(rows)` stops failing with `too many SQL variables`.

Works on drizzle-orm 0.36, 0.45 and 1.0.

> Work in progress: the API is being built in small steps and is not published to npm yet.

## License

MIT
