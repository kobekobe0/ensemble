// Stack detection (§13.1), file tree for planning, AGENTS.md handling.
import fs from 'node:fs';
import path from 'node:path';
import type { StackInfo } from './types.js';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'target', 'bin', 'obj',
  '.dart_tool', '.idea', '.vscode', '__pycache__', '.venv', 'venv', '.turbo', '.cache', 'vendor', 'Pods', '.gradle',
]);

const readJson = (f: string): any => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
};
const exists = (f: string) => { try { fs.accessSync(f); return true; } catch { return false; } };
const listDir = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

function packageManager(dir: string): string {
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

const NPM_PLACEHOLDER = /no test specified/i;

interface Found { kinds: string[]; test: string | null; setup: string | null; pm?: string; depth: number; prefix: string }

function detectIn(dir: string, prefix: string, depth: number): Found[] {
  const found: Found[] = [];
  const cd = (cmd: string) => (prefix ? `cd ${shellQuote(prefix)} && ${cmd}` : cmd);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const pm = packageManager(dir);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const kinds = ['node'];
    for (const [dep, kind] of [['next', 'next'], ['@angular/core', 'angular'], ['react', 'react'], ['vite', 'vite'], ['express', 'express'], ['@nestjs/core', 'nestjs']] as const) {
      if (deps[dep]) kinds.push(kind);
    }
    if (deps.typescript || exists(path.join(dir, 'tsconfig.json'))) kinds.push('typescript');
    const scripts = pkg.scripts ?? {};
    let test: string | null = null;
    if (typeof scripts.test === 'string' && !NPM_PLACEHOLDER.test(scripts.test)) test = `${pm} test`;
    else if (typeof scripts.build === 'string') test = `${pm} run build`;
    found.push({ kinds, test: test && cd(test), setup: null, pm, depth, prefix });
  }
  const entries = listDir(dir);
  if (entries.some((e) => e.isFile() && (e.name.endsWith('.sln') || e.name.endsWith('.csproj')))) {
    const hasTests = entries.some((e) => /test/i.test(e.name)) || entries.some((e) => e.isFile() && e.name.endsWith('.sln'));
    found.push({ kinds: ['dotnet'], test: cd(hasTests ? 'dotnet test' : 'dotnet build'), setup: cd('dotnet restore'), depth, prefix });
  }
  if (exists(path.join(dir, 'pubspec.yaml'))) found.push({ kinds: ['flutter'], test: cd('flutter test'), setup: cd('flutter pub get'), depth, prefix });
  if (exists(path.join(dir, 'go.mod'))) found.push({ kinds: ['go'], test: cd('go test ./...'), setup: null, depth, prefix });
  if (exists(path.join(dir, 'Cargo.toml'))) found.push({ kinds: ['rust'], test: cd('cargo test'), setup: null, depth, prefix });
  if (exists(path.join(dir, 'pyproject.toml')) || exists(path.join(dir, 'requirements.txt'))) found.push({ kinds: ['python'], test: cd('pytest'), setup: null, depth, prefix });
  return found;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Detect stacks in the repo root and one level down (monorepos). Root-level findings win for suggestions. */
export function detectStack(root: string): StackInfo {
  const found = detectIn(root, '', 0);
  for (const e of listDir(root)) {
    if (!e.isDirectory() || e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    found.push(...detectIn(path.join(root, e.name), e.name, 1));
  }
  const kinds = [...new Set(found.flatMap((f) => f.kinds))];
  const primary = found.find((f) => f.test) ?? found[0];
  return {
    kinds,
    packageManager: found.find((f) => f.pm)?.pm,
    suggestedTest: primary?.test ?? null,
    suggestedSetup: found.find((f) => f.setup)?.setup ?? null,
  };
}

/** Top-level tree (depth 2, max 300 entries) for the planning prompt. */
export function fileTree(root: string, maxDepth = 2, maxEntries = 300): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (dir: string, depth: number, indent: string) => {
    const entries = listDir(dir)
      .filter((e) => !(e.isDirectory() && (IGNORED_DIRS.has(e.name) || e.name.startsWith('.'))) && e.name !== '.DS_Store')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= maxEntries) return;
      count++;
      lines.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && depth < maxDepth) walk(path.join(dir, e.name), depth + 1, indent + '  ');
    }
  };
  walk(root, 1, '');
  if (count >= maxEntries) lines.push(`… (truncated at ${maxEntries} entries)`);
  return lines.join('\n');
}

export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

export function agentFiles(root: string): Record<(typeof AGENT_FILES)[number], { exists: boolean; symlink: boolean }> {
  const out = {} as Record<(typeof AGENT_FILES)[number], { exists: boolean; symlink: boolean }>;
  for (const f of AGENT_FILES) {
    const p = path.join(root, f);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(p); } catch { /* missing */ }
    out[f] = { exists: !!st, symlink: !!st?.isSymbolicLink() };
  }
  return out;
}

/** Content of the first agent instructions file found (max 20 KB). */
export function readAgentsMd(root: string, max = 20 * 1024): { file: string; content: string } | null {
  for (const f of AGENT_FILES) {
    try {
      const c = fs.readFileSync(path.join(root, f), 'utf8');
      return { file: f, content: c.length > max ? c.slice(0, max) + '\n… (truncated)' : c };
    } catch { /* next */ }
  }
  return null;
}

export function writeAgentsMd(root: string, content: string, linkAliases: boolean): string[] {
  const written: string[] = [];
  fs.writeFileSync(path.join(root, 'AGENTS.md'), content.endsWith('\n') ? content : content + '\n');
  written.push('AGENTS.md');
  if (linkAliases) {
    for (const alias of ['CLAUDE.md', 'GEMINI.md']) {
      const p = path.join(root, alias);
      let present = false;
      try { fs.lstatSync(p); present = true; } catch { /* missing */ }
      if (!present) { fs.symlinkSync('AGENTS.md', p); written.push(`${alias} → AGENTS.md`); }
    }
  }
  return written;
}

/** Directories inside the repo (depth ≤ 2) that have their own node_modules, as repo-relative paths. */
export function nodeModulesDirs(root: string): string[] {
  const out: string[] = [];
  if (exists(path.join(root, 'node_modules'))) out.push('.');
  const scan = (dir: string, rel: string, depth: number) => {
    for (const e of listDir(dir)) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (exists(path.join(sub, 'node_modules')) && exists(path.join(sub, 'package.json'))) out.push(r);
      if (depth < 2) scan(sub, r, depth + 1);
    }
  };
  scan(root, '', 1);
  return out;
}
