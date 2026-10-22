#!/usr/bin/env node
// Minimal CLI. Data lives in a JSON file (an array of books).
//   node src/cli.js add <title> <author> <year>
//   node src/cli.js list
import fs from 'node:fs';
import { createStore } from './store.js';

const file = process.env.BOOKSHELF_FILE ?? './books.json';
const initial = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const store = createStore(initial);
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'add') {
  const [title, author, year] = args;
  const book = store.add({ title, author, year: Number(year) });
  fs.writeFileSync(file, JSON.stringify(store.list(), null, 2));
  console.log(JSON.stringify(book));
} else if (cmd === 'list') {
  console.log(JSON.stringify(store.list(), null, 2));
} else {
  console.error('usage: cli.js add <title> <author> <year> | list');
  process.exit(1);
}
