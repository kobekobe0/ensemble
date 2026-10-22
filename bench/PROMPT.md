Turn this repo ("bookshelf", plain Node ESM, node:test, no dependencies) into a usable catalogue: validation, search, durable storage, CSV import/export and a real CLI. Do not add any npm dependencies. Keep all existing tests passing, and add tests for everything new. Follow the API below exactly: other code depends on these names and behaviours.

1. Validation — `src/errors.js` exports `class ValidationError extends Error` with `name === 'ValidationError'` and a `field` property naming the bad field.
   `store.add(book)` validates and normalizes its input, and so does a new `store.update(id, patch)`:
   - `title`, `author`: required non-empty strings after trimming; stored trimmed.
   - `year`: required integer from 1450 to the current year inclusive.
   - `tags`: optional array of strings. Normalize: trim, lowercase, drop empty ones, remove duplicates (keep first-seen order). More than 10 tags after normalization is invalid. Default `[]`.
   - Invalid input throws `ValidationError` with `field` set to `'title'`, `'author'`, `'year'` or `'tags'`. Unknown properties are ignored (never stored).
   - `update(id, patch)` merges the patch into the existing book, validates the result, saves it and returns a copy. It returns `null` for an unknown id and never changes the id.
   - `createStore(initial)` keeps an `id` given on an initial book; books without one get a new id. New ids always continue after the highest id in use.

2. Search — `store.search(options)` returns `{ total, items }`. All options are optional:
   - `q`: case-insensitive substring match on title OR author.
   - `author`: case-insensitive exact match on author. `tag`: the book has that tag (case-insensitive).
   - `yearFrom` / `yearTo`: inclusive bounds.
   - `sort`: `'title'` (default; case-insensitive A→Z), `'year'` (oldest first) or `'-year'` (newest first). Ties are ordered by id ascending.
   - `limit` (default 20, clamped to 1..100) and `offset` (default 0). `total` counts matches before pagination.
   - Items are copies; mutating them must not affect the store.

3. Durable storage — `src/persist.js` exports synchronous `saveStore(store, filePath)` and `loadStore(filePath)`:
   - Save writes `{ "version": 1, "books": [...] }` atomically: write a temp file in the same directory, then rename it over the target. Create missing parent directories.
   - Load returns a new store with the same books and ids. A missing file gives an empty store. The legacy format (a plain JSON array of books, as written by the current CLI) must also load. Malformed JSON throws an `Error` whose message contains the file path.

4. CSV — `src/csv.js` exports `toCSV(books)` and `fromCSV(text)`:
   - Header `id,title,author,year,tags`, one row per book, `\n` line endings, and a trailing newline. Tags are joined with `;`.
   - RFC 4180 quoting: a field containing a comma, double quote, CR or LF is wrapped in double quotes, with inner quotes doubled.
   - `fromCSV` parses that format back, including quoted fields with commas, quotes and embedded newlines, and both `\n` and `\r\n`. Columns are found by header name in any order; `id` is optional. It returns plain objects `{ title, author, year: Number, tags: string[] }` (with `id: Number` when an id column exists). An empty tags cell becomes `[]`. A row with the wrong number of fields throws an `Error` whose message includes `row N`, where N is the 1-based data row.

5. CLI — rewrite `src/cli.js` on top of `persist.js`. The data file is `$BOOKSHELF_FILE`, default `./books.json`; existing legacy files must keep working.
   - `add --title <t> --author <a> --year <y> [--tags a,b,c]` prints the created book as JSON. A validation error prints a message containing the field name to stderr and exits with code 2.
   - `list` prints a JSON array of all books.
   - `search [--q s] [--author a] [--tag t] [--from y] [--to y] [--sort title|year|-year] [--limit n] [--offset n]` prints `{ total, items }` as JSON.
   - `export --csv` prints the CSV of all books to stdout.
   - `import <file.csv>` validates every row first. If any row is invalid, it imports nothing, prints the problem to stderr and exits with code 2. Otherwise it adds all rows (ids from the file are ignored) and prints `Imported N books`.
   - A missing or unknown command prints usage to stderr and exits with code 1.

6. Docs — update README.md to document the library API and every CLI command, with examples.
