// Hidden acceptance tests for the bookshelf benchmark (bench/PROMPT.md).
// Do NOT give these to the agents. bench/score.sh copies this file into a scratch copy of a finished repo
// at test-acceptance/ and runs it there. Each test imports its module lazily, so a missing module only
// fails the tests that need it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(path.join(ROOT, rel));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-acc-'));
const THIS_YEAR = new Date().getFullYear();

async function store(initial) {
  const { createStore } = await load('src/store.js');
  return createStore(initial);
}
async function expectField(fn, field) {
  const { ValidationError } = await load('src/errors.js');
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected a ValidationError for ${field}`);
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.constructor?.name}`);
  assert.equal(err.name, 'ValidationError');
  assert.equal(err.field, field);
}
const ok = { title: 'Dune', author: 'Frank Herbert', year: 1965 };

// ---------------------------------------------------------------- validation
test('[validation] ValidationError is an Error with name and field', async () => {
  const { ValidationError } = await load('src/errors.js');
  const e = new ValidationError('bad', 'title');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ValidationError');
});

test('[validation] trims title/author and defaults tags', async () => {
  const s = await store();
  const b = s.add({ title: '  Dune ', author: ' Frank Herbert  ', year: 1965 });
  assert.equal(b.title, 'Dune');
  assert.equal(b.author, 'Frank Herbert');
  assert.deepEqual(b.tags, []);
});

test('[validation] rejects missing/blank title and author', async () => {
  const s = await store();
  await expectField(() => s.add({ ...ok, title: '   ' }), 'title');
  await expectField(() => s.add({ ...ok, title: undefined }), 'title');
  await expectField(() => s.add({ ...ok, author: '' }), 'author');
  await expectField(() => s.add({ ...ok, author: 42 }), 'author');
});

test('[validation] year must be an integer in 1450..current year', async () => {
  const s = await store();
  await expectField(() => s.add({ ...ok, year: 1449 }), 'year');
  await expectField(() => s.add({ ...ok, year: THIS_YEAR + 1 }), 'year');
  await expectField(() => s.add({ ...ok, year: 1999.5 }), 'year');
  await expectField(() => s.add({ ...ok, year: '1999' }), 'year');
  assert.equal(s.add({ ...ok, year: 1450 }).year, 1450);
  assert.equal(s.add({ ...ok, year: THIS_YEAR }).year, THIS_YEAR);
});

test('[validation] tags are trimmed, lowercased, de-duplicated in order', async () => {
  const s = await store();
  const b = s.add({ ...ok, tags: [' SciFi', 'classic', 'scifi ', '', 'Desert'] });
  assert.deepEqual(b.tags, ['scifi', 'classic', 'desert']);
});

test('[validation] more than 10 tags or non-string tags are rejected', async () => {
  const s = await store();
  await expectField(() => s.add({ ...ok, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), 'tags');
  await expectField(() => s.add({ ...ok, tags: ['ok', 3] }), 'tags');
  await expectField(() => s.add({ ...ok, tags: 'scifi' }), 'tags');
  // 11 raw tags that normalize to 10 are fine
  const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
  assert.equal(s.add({ ...ok, tags: [...ten, 'T0'] }).tags.length, 10);
});

test('[validation] unknown properties are not stored', async () => {
  const s = await store();
  const b = s.add({ ...ok, isbn: '123', id: 999 });
  assert.equal('isbn' in b, false);
  assert.equal(s.get(b.id).isbn, undefined);
});

test('[validation] update merges, validates, keeps id; null for unknown id', async () => {
  const s = await store();
  const b = s.add({ ...ok, tags: ['a'] });
  const u = s.update(b.id, { year: 1966, tags: ['B', 'b'], id: 77 });
  assert.equal(u.id, b.id);
  assert.equal(u.year, 1966);
  assert.equal(u.title, 'Dune');
  assert.deepEqual(u.tags, ['b']);
  assert.deepEqual(s.get(b.id), u);
  await expectField(() => s.update(b.id, { title: ' ' }), 'title');
  assert.equal(s.get(b.id).title, 'Dune', 'failed update must not change the book');
  assert.equal(s.update(12345, { year: 2000 }), null);
});

test('[validation] createStore keeps given ids and continues after the max', async () => {
  const s = await store([{ id: 5, ...ok }, { ...ok, title: 'Children of Dune' }, { id: 2, ...ok, title: 'Messiah' }]);
  const ids = s.list().map((b) => b.id).sort((a, b) => a - b);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes(5) && ids.includes(2));
  const next = s.add({ ...ok, title: 'Heretics' });
  assert.ok(next.id > 5, `new id ${next.id} should be greater than 5`);
  assert.equal(new Set(s.list().map((b) => b.id)).size, 4);
});

// ---------------------------------------------------------------- search
const CATALOG = [
  { title: 'dune', author: 'Frank Herbert', year: 1965, tags: ['scifi', 'classic'] },
  { title: 'Neuromancer', author: 'William Gibson', year: 1984, tags: ['scifi', 'cyberpunk'] },
  { title: 'Emma', author: 'Jane Austen', year: 1815, tags: ['classic', 'romance'] },
  { title: 'Count Zero', author: 'William Gibson', year: 1986, tags: ['cyberpunk'] },
  { title: 'Persuasion', author: 'Jane Austen', year: 1817, tags: ['classic'] },
  { title: 'Children of Dune', author: 'Frank Herbert', year: 1976, tags: ['scifi'] },
];

test('[search] default: all books sorted by title case-insensitively', async () => {
  const s = await store(CATALOG);
  const r = s.search();
  assert.equal(r.total, 6);
  assert.deepEqual(r.items.map((b) => b.title), ['Children of Dune', 'Count Zero', 'dune', 'Emma', 'Neuromancer', 'Persuasion']);
});

test('[search] q matches title or author, case-insensitive', async () => {
  const s = await store(CATALOG);
  assert.deepEqual(s.search({ q: 'DUNE' }).items.map((b) => b.title), ['Children of Dune', 'dune']);
  assert.equal(s.search({ q: 'gibson' }).total, 2);
});

test('[search] author exact (case-insensitive) and tag filters', async () => {
  const s = await store(CATALOG);
  assert.equal(s.search({ author: 'jane austen' }).total, 2);
  assert.equal(s.search({ author: 'Jane' }).total, 0);
  assert.deepEqual(s.search({ tag: 'CYBERPUNK' }).items.map((b) => b.title), ['Count Zero', 'Neuromancer']);
});

test('[search] inclusive year range and combined filters', async () => {
  const s = await store(CATALOG);
  assert.deepEqual(s.search({ yearFrom: 1815, yearTo: 1817 }).items.map((b) => b.year).sort(), [1815, 1817]);
  assert.equal(s.search({ yearFrom: 1984 }).total, 2);
  assert.deepEqual(s.search({ tag: 'scifi', yearTo: 1980 }).items.map((b) => b.title), ['Children of Dune', 'dune']);
});

test('[search] sort by year and -year with id tie-break', async () => {
  const s = await store([...CATALOG, { title: 'Zed', author: 'Z', year: 1965 }]);
  assert.deepEqual(s.search({ sort: 'year' }).items.map((b) => b.year), [1815, 1817, 1965, 1965, 1976, 1984, 1986]);
  const desc = s.search({ sort: '-year' }).items;
  assert.deepEqual(desc.map((b) => b.year), [1986, 1984, 1976, 1965, 1965, 1817, 1815]);
  const tied = desc.filter((b) => b.year === 1965);
  assert.ok(tied[0].id < tied[1].id, 'ties ordered by id ascending');
});

test('[search] limit/offset paginate after counting total', async () => {
  const s = await store(CATALOG);
  const r = s.search({ limit: 2, offset: 1 });
  assert.equal(r.total, 6);
  assert.deepEqual(r.items.map((b) => b.title), ['Count Zero', 'dune']);
  assert.equal(s.search({ offset: 10 }).items.length, 0);
});

test('[search] default limit 20, limit clamped to 100', async () => {
  const s = await store(Array.from({ length: 130 }, (_, i) => ({ title: `Book ${String(i).padStart(3, '0')}`, author: 'A', year: 2000 })));
  assert.equal(s.search().items.length, 20);
  assert.equal(s.search({ limit: 500 }).items.length, 100);
  assert.equal(s.search().total, 130);
});

test('[search] results are copies', async () => {
  const s = await store(CATALOG);
  const r = s.search({ q: 'emma' });
  r.items[0].title = 'Hacked';
  r.items[0].tags.push('x');
  const again = s.search({ q: 'emma' }).items[0];
  assert.equal(again.title, 'Emma');
  assert.deepEqual(again.tags, ['classic', 'romance']);
});

// ---------------------------------------------------------------- persistence
test('[persist] save writes versioned JSON; load restores books and ids', async () => {
  const { saveStore, loadStore } = await load('src/persist.js');
  const dir = tmp();
  const file = path.join(dir, 'nested', 'deeper', 'books.json');
  const s = await store(CATALOG.slice(0, 3));
  s.remove(2);
  saveStore(s, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.books.length, 2);
  const loaded = loadStore(file);
  assert.deepEqual(loaded.list().sort((a, b) => a.id - b.id), s.list().sort((a, b) => a.id - b.id));
  assert.ok(loaded.add({ ...ok, title: 'New' }).id > 3, 'ids continue after the max');
});

test('[persist] missing file → empty store', async () => {
  const { loadStore } = await load('src/persist.js');
  assert.deepEqual(loadStore(path.join(tmp(), 'nope.json')).list(), []);
});

test('[persist] legacy plain-array file loads', async () => {
  const { loadStore } = await load('src/persist.js');
  const file = path.join(tmp(), 'books.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 1, title: 'Dune', author: 'Frank Herbert', year: 1965, tags: [] }, { id: 4, title: 'Emma', author: 'Jane Austen', year: 1815, tags: [] }], null, 2));
  const s = loadStore(file);
  assert.deepEqual(s.list().map((b) => b.id).sort(), [1, 4]);
  assert.equal(s.get(4).title, 'Emma');
});

test('[persist] malformed JSON throws with the path in the message', async () => {
  const { loadStore } = await load('src/persist.js');
  const file = path.join(tmp(), 'broken.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadStore(file), (e) => e instanceof Error && e.message.includes(file));
});

test('[persist] save is atomic (temp file + rename, no leftovers)', async () => {
  const { saveStore } = await load('src/persist.js');
  const dir = tmp();
  const file = path.join(dir, 'books.json');
  fs.writeFileSync(file, 'old');
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return orig(a, b); };
  syncBuiltinESMExports(); // so `import { renameSync } from 'node:fs'` sees the spy too
  try { saveStore(await store(CATALOG), file); } finally { fs.renameSync = orig; syncBuiltinESMExports(); }
  assert.ok(renames.some(([a, b]) => path.resolve(b) === file && path.dirname(path.resolve(a)) === dir && path.resolve(a) !== file), 'expected a rename from a temp file in the same directory');
  assert.deepEqual(fs.readdirSync(dir), ['books.json']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).books.length, 6);
});

// ---------------------------------------------------------------- csv
test('[csv] toCSV header, rows, tags joined with ; and trailing newline', async () => {
  const { toCSV } = await load('src/csv.js');
  const csv = toCSV([{ id: 1, title: 'Dune', author: 'Frank Herbert', year: 1965, tags: ['scifi', 'classic'] }]);
  assert.equal(csv, 'id,title,author,year,tags\n1,Dune,Frank Herbert,1965,scifi;classic\n');
});

test('[csv] RFC 4180 quoting for commas, quotes and newlines', async () => {
  const { toCSV } = await load('src/csv.js');
  const csv = toCSV([{ id: 2, title: 'Hello, "World"', author: 'Line\nBreak', year: 2001, tags: [] }]);
  assert.equal(csv, 'id,title,author,year,tags\n2,"Hello, ""World""","Line\nBreak",2001,\n');
});

test('[csv] round trip through fromCSV', async () => {
  const { toCSV, fromCSV } = await load('src/csv.js');
  const books = [
    { id: 1, title: 'Hello, "World"', author: 'A\nB', year: 2001, tags: ['x', 'y'] },
    { id: 2, title: 'Plain', author: 'C', year: 1999, tags: [] },
  ];
  assert.deepEqual(fromCSV(toCSV(books)), books);
});

test('[csv] fromCSV: any column order, optional id, CRLF, empty tags', async () => {
  const { fromCSV } = await load('src/csv.js');
  const rows = fromCSV('year,tags,author,title\r\n1965,scifi;classic,Frank Herbert,Dune\r\n1815,,Jane Austen,"Emma, a novel"\r\n');
  assert.deepEqual(rows, [
    { title: 'Dune', author: 'Frank Herbert', year: 1965, tags: ['scifi', 'classic'] },
    { title: 'Emma, a novel', author: 'Jane Austen', year: 1815, tags: [] },
  ]);
});

test('[csv] wrong field count throws with "row N"', async () => {
  const { fromCSV } = await load('src/csv.js');
  assert.throws(() => fromCSV('id,title,author,year,tags\n1,A,B,2000,\n2,C,D\n'), (e) => /row 2\b/.test(e.message));
});

// ---------------------------------------------------------------- cli
function cli(args, file, input) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], {
    cwd: path.dirname(file), env: { ...process.env, BOOKSHELF_FILE: file }, encoding: 'utf8', input, timeout: 15_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('[cli] add prints the book; list prints all', () => {
  const file = path.join(tmp(), 'books.json');
  const r = cli(['add', '--title', 'Dune', '--author', 'Frank Herbert', '--year', '1965', '--tags', 'SciFi,classic'], file);
  assert.equal(r.code, 0, r.err);
  const b = JSON.parse(r.out);
  assert.equal(b.title, 'Dune');
  assert.deepEqual(b.tags, ['scifi', 'classic']);
  const l = cli(['list'], file);
  assert.equal(l.code, 0, l.err);
  assert.equal(JSON.parse(l.out).length, 1);
});

test('[cli] add with invalid input exits 2 and names the field', () => {
  const file = path.join(tmp(), 'books.json');
  const r = cli(['add', '--title', 'Dune', '--author', 'Frank Herbert', '--year', '1200'], file);
  assert.equal(r.code, 2);
  assert.match(r.err, /year/);
  const l = cli(['list'], file);
  assert.deepEqual(JSON.parse(l.out || '[]'), []);
});

test('[cli] search with filters prints { total, items }', () => {
  const file = path.join(tmp(), 'books.json');
  for (const [t, a, y, tags] of [['Dune', 'Frank Herbert', '1965', 'scifi'], ['Emma', 'Jane Austen', '1815', 'classic'], ['Neuromancer', 'William Gibson', '1984', 'scifi']]) {
    assert.equal(cli(['add', '--title', t, '--author', a, '--year', y, '--tags', tags], file).code, 0);
  }
  const r = cli(['search', '--tag', 'scifi', '--sort', '-year', '--limit', '1'], file);
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out);
  assert.equal(res.total, 2);
  assert.deepEqual(res.items.map((b) => b.title), ['Neuromancer']);
  const q = JSON.parse(cli(['search', '--q', 'austen', '--from', '1800', '--to', '1820'], file).out);
  assert.deepEqual(q.items.map((b) => b.title), ['Emma']);
});

test('[cli] export --csv and import round trip into another file', () => {
  const dir = tmp();
  const a = path.join(dir, 'a.json');
  cli(['add', '--title', 'Hello, "World"', '--author', 'Someone', '--year', '2001', '--tags', 'x,y'], a);
  const exp = cli(['export', '--csv'], a);
  assert.equal(exp.code, 0, exp.err);
  assert.match(exp.out, /^id,title,author,year,tags\n/);
  const csvFile = path.join(dir, 'out.csv');
  fs.writeFileSync(csvFile, exp.out);
  const b = path.join(dir, 'b.json');
  cli(['add', '--title', 'Existing', '--author', 'X', '--year', '2000'], b);
  const imp = cli(['import', csvFile], b);
  assert.equal(imp.code, 0, imp.err);
  assert.match(imp.out, /Imported 1 books?/);
  const titles = JSON.parse(cli(['list'], b).out).map((x) => x.title).sort();
  assert.deepEqual(titles, ['Existing', 'Hello, "World"']);
});

test('[cli] import is all-or-nothing on invalid rows', () => {
  const dir = tmp();
  const file = path.join(dir, 'books.json');
  const csvFile = path.join(dir, 'bad.csv');
  fs.writeFileSync(csvFile, 'title,author,year,tags\nGood,A,2000,\nBad,B,999,\n');
  const r = cli(['import', csvFile], file);
  assert.equal(r.code, 2);
  assert.ok(r.err.length > 0);
  const l = cli(['list'], file);
  assert.deepEqual(JSON.parse(l.out || '[]'), []);
});

test('[cli] legacy books.json still works and is upgraded on write', () => {
  const file = path.join(tmp(), 'books.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 3, title: 'Dune', author: 'Frank Herbert', year: 1965, tags: [] }], null, 2));
  assert.equal(JSON.parse(cli(['list'], file).out)[0].id, 3);
  const added = JSON.parse(cli(['add', '--title', 'Emma', '--author', 'Jane Austen', '--year', '1815'], file).out);
  assert.ok(added.id > 3);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.books.length, 2);
});

test('[cli] unknown or missing command exits 1 with usage on stderr', () => {
  const file = path.join(tmp(), 'books.json');
  const r = cli(['frobnicate'], file);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage/i);
  assert.equal(cli([], file).code, 1);
});
