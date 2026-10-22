// Folder browser restricted to allowedRoots (§13, §16). All paths are realpath-resolved before the
// prefix check, so symlinks and `..` cannot escape a root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './config.js';

export class FsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function real(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

export function realRoots(roots: string[]): string[] {
  return roots.map((r) => real(expandHome(r))).filter((r): r is string => !!r);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a user-supplied path (supports ~) and ensure it is inside an allowed root. */
export function resolveAllowed(input: string, roots: string[]): string {
  if (typeof input !== 'string' || !input.trim()) throw new FsError('path is required');
  const expanded = expandHome(input.trim());
  if (!path.isAbsolute(expanded)) throw new FsError('path must be absolute (or start with ~)');
  const r = real(expanded);
  if (!r) throw new FsError(`folder not found: ${input}`, 404);
  if (!realRoots(roots).some((root) => isInside(r, root))) {
    throw new FsError(`${input} is outside the allowed folders. Add a parent folder under Settings → Allowed roots.`, 403);
  }
  return r;
}

export interface FsEntry { name: string; path: string; isGitRepo: boolean }

const tildify = (p: string) => (p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p);
const isGitRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'));

export function listRoots(roots: string[]): FsEntry[] {
  return roots
    .map((r) => ({ input: r, real: real(expandHome(r)) }))
    .filter((r) => r.real)
    .map((r) => ({ name: tildify(expandHome(r.input).replace(/\/$/, '')), path: r.real!, isGitRepo: isGitRepo(r.real!) }));
}

export function listDir(input: string, roots: string[], showHidden = false): { path: string; root: string; parent: string | null; entries: FsEntry[]; isGitRepo: boolean } {
  const dir = resolveAllowed(input, roots);
  // Deepest root containing dir, for breadcrumbs.
  const root = realRoots(roots).filter((r) => isInside(dir, r)).sort((a, b) => b.length - a.length)[0];
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    throw new FsError(`cannot read ${dir}: ${(e as Error).message}`, 403);
  }
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue;
    if (d.name === 'node_modules') continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const r = real(full);
      // Only show symlinked folders whose target is still inside a root.
      if (!r || !realRoots(roots).some((root) => isInside(r, root))) continue;
      try { isDir = fs.statSync(r).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    entries.push({ name: d.name, path: full, isGitRepo: isGitRepo(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parentDir = path.dirname(dir);
  const parent = realRoots(roots).some((root) => isInside(parentDir, root)) && parentDir !== dir ? parentDir : null;
  return { path: dir, root, parent, entries, isGitRepo: isGitRepo(dir) };
}
