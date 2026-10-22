import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockOptions } from '../../src/adapters/mock.js';
import { defaultConfig, deepMerge } from '../../src/config.js';
import { Engine } from '../../src/engine.js';
import type { Config, Run, Task } from '../../src/types.js';

mockOptions.speed = 0.01;

export function tmpDir(prefix = 'ens-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** A temp git repo with one commit on `main`. */
export function makeRepo(root: string, name = 'repo'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export interface TestEnv {
  root: string;
  repo: string;
  engine: Engine;
  close(): Promise<void>;
}

export async function makeEnv(over: Partial<Config> = {}, opts: { root?: string; repo?: string; start?: boolean } = {}): Promise<TestEnv> {
  const root = opts.root ?? tmpDir();
  const repo = opts.repo ?? makeRepo(root);
  const config = deepMerge(defaultConfig(), {
    allowedRoots: [root], worktreeDir: path.join(root, 'worktrees'), keepAwake: false, maxParallel: 4, ...over,
  } as Partial<Config>);
  const engine = new Engine({ config, dataDir: path.join(root, 'data'), demo: true, tickMs: 50, limitGraceMs: 0, persistConfig: false });
  if (opts.start !== false) await engine.start();
  return {
    root, repo, engine,
    async close() { await engine.shutdown(); },
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function registerProject(env: TestEnv, testCommand: string | null = null) {
  return env.engine.db.upsertProject({
    path: env.repo, name: path.basename(env.repo), stack: { kinds: [], suggestedTest: null, suggestedSetup: null },
    testCommand, setupCommand: null, linkNodeModules: true,
  });
}

export function tasksOf(env: TestEnv, runId: string): Task[] {
  return env.engine.db.listTasks(runId);
}

export function runOf(env: TestEnv, runId: string): Run {
  return env.engine.db.getRun(runId)!;
}

export async function waitTasks(env: TestEnv, runId: string, pred: (ts: Task[]) => boolean, what = 'tasks', timeoutMs = 15_000) {
  return waitFor(() => {
    const ts = tasksOf(env, runId);
    return ts.length && pred(ts) ? ts : null;
  }, timeoutMs, what);
}
