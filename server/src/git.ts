// Git and worktree management (§7). Every call goes through execFile — never a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) { super(message); }
}

export function git(cwd: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof (err as any).code === 'number' ? (err as any).code : null;
        reject(new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 2000)}`, String(stderr ?? ''), code));
      } else resolve(String(stdout));
    });
  });
}

const BOT = ['-c', 'user.name=Ensemble', '-c', 'user.email=ensemble@local'];

export async function toplevel(dir: string): Promise<string | null> {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

export async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init']);
  await git(dir, ['add', '-A']);
  await git(dir, [...BOT, 'commit', '--allow-empty', '-m', 'Initial commit']);
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function headCommit(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

export async function hasCommits(repo: string): Promise<boolean> {
  try { await git(repo, ['rev-parse', '--verify', 'HEAD']); return true; } catch { return false; }
}

/** `git status --porcelain` lines (untracked files included). */
export async function statusPorcelain(dir: string): Promise<string[]> {
  return (await git(dir, ['status', '--porcelain'])).split('\n').filter(Boolean);
}

export async function isDirty(dir: string): Promise<boolean> {
  return (await statusPorcelain(dir)).length > 0;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try { await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; }
}

export interface WorktreeSpec {
  repo: string;
  branch: string;
  dir: string;
  base: string;
}

/** Create a fresh worktree + branch at `base`. Replaces any leftover worktree/branch of the same name. */
export async function addWorktree(spec: WorktreeSpec): Promise<void> {
  await removeWorktree(spec.repo, spec.dir);
  if (await branchExists(spec.repo, spec.branch)) await git(spec.repo, ['branch', '-D', spec.branch]);
  fs.mkdirSync(path.dirname(spec.dir), { recursive: true });
  await git(spec.repo, ['worktree', 'add', '-b', spec.branch, spec.dir, spec.base]);
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  if (fs.existsSync(dir)) {
    try { await git(repo, ['worktree', 'remove', '--force', dir]); } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try { await git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  try { await git(repo, ['branch', '-D', branch]); } catch { /* already gone */ }
}

export async function pruneWorktrees(repo: string): Promise<void> {
  try { await git(repo, ['worktree', 'prune']); } catch { /* not a repo any more */ }
}

/** Merge `branch` into the worktree's current branch. Returns conflicting files on failure (merge is aborted). */
export async function mergeInto(dir: string, branch: string, message?: string, noFf = false): Promise<{ ok: true } | { ok: false; conflicts: string[]; error: string }> {
  const args = [...BOT, 'merge', '--no-edit'];
  if (noFf) args.push('--no-ff');
  if (message) args.push('-m', message);
  args.push(branch);
  try {
    await git(dir, args);
    return { ok: true };
  } catch (e) {
    let conflicts: string[] = [];
    try { conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean); } catch { /* ignore */ }
    try { await git(dir, ['merge', '--abort']); } catch { /* nothing to abort */ }
    return { ok: false, conflicts, error: (e as Error).message };
  }
}

/** Path of the per-worktree info/exclude file. */
export async function excludeFile(dir: string): Promise<string> {
  const p = (await git(dir, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  return path.isAbsolute(p) ? p : path.join(dir, p);
}

export async function addExclude(dir: string, pattern: string): Promise<void> {
  const file = await excludeFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!cur.split('\n').includes(pattern)) fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n');
}

/** Stage everything except node_modules symlinks and commit if there is anything to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  const status = await statusPorcelain(dir);
  if (!status.length) return false;
  await git(dir, ['add', '-A', '--', '.', ':!node_modules', ':!**/node_modules']);
  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return false;
  await git(dir, [...BOT, 'commit', '--no-verify', '-m', message]);
  return true;
}

export async function diffStat(repo: string, base: string, branch: string): Promise<string> {
  return git(repo, ['diff', '--stat', `${base}...${branch}`]);
}

export async function diff(repo: string, base: string, branch: string): Promise<string> {
  return git(repo, ['diff', `${base}...${branch}`]);
}

export async function changedFilesSince(dir: string, base: string): Promise<string[]> {
  return (await git(dir, ['diff', '--name-only', base])).split('\n').filter(Boolean);
}

/** Number of commits on `branch` not on `base`. */
export async function commitsAhead(repo: string, base: string, branch: string): Promise<number> {
  return Number((await git(repo, ['rev-list', '--count', `${base}..${branch}`])).trim()) || 0;
}

export async function resetHard(dir: string, ref: string): Promise<void> {
  await git(dir, ['reset', '--hard', ref]);
  await git(dir, ['clean', '-fd', '-e', 'node_modules']);
}
