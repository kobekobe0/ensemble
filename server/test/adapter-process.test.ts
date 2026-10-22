import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/adapters/base.js';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import type { AgentEvent } from '../src/types.js';
import { tmpDir } from './helpers/env.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function script(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const req = (cwd: string, events: AgentEvent[], extra: Partial<Parameters<ReturnType<typeof createClaudeAdapter>['run']>[0]> = {}) => ({
  cwd, prompt: 'hello', model: '', readOnly: true, timeoutMs: 10_000, signal: new AbortController().signal,
  onEvent: (e: AgentEvent) => events.push(e), ...extra,
});

describe('adapter process handling', () => {
  it('streams a CLI\'s JSONL through the parser', async () => {
    const dir = tmpDir();
    const bin = script(dir, 'fake-claude', `cat "${path.join(fixtures, 'claude.jsonl')}"`);
    const events: AgentEvent[] = [];
    const res = await createClaudeAdapter(() => bin, () => []).run(req(dir, events));
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('1e958432-b43e-4b9a-82cd-3b8d11597c0e');
    expect(res.finalText).toContain('DONE');
    expect(events.some((e) => e.kind === 'command')).toBe(true);
  });

  it('pipes very large prompts through stdin', async () => {
    const dir = tmpDir();
    const bin = script(dir, 'echo-stdin', `wc -c | tr -d ' ' > "${dir}/stdin-bytes"; cat "${path.join(fixtures, 'claude.jsonl')}"`);
    const big = 'x'.repeat(150 * 1024);
    const res = await createClaudeAdapter(() => bin, () => []).run(req(dir, [], { prompt: big }));
    expect(res.ok).toBe(true);
    expect(Number(fs.readFileSync(path.join(dir, 'stdin-bytes'), 'utf8'))).toBe(big.length);
  });

  it('detects limits from stderr on failure', async () => {
    const dir = tmpDir();
    const bin = script(dir, 'limited', `echo "Error: 429 rate limit exceeded, try again in 5 minutes" >&2; exit 1`);
    const before = Date.now();
    const res = await createClaudeAdapter(() => bin, () => []).run(req(dir, []));
    expect(res.ok).toBe(false);
    expect(res.limited).not.toBeNull();
    expect(res.limited!.resetAt! - before).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
  });

  it('does not treat stderr noise as a limit when the run succeeds', async () => {
    const dir = tmpDir();
    const bin = script(dir, 'noisy', `echo "retrying after 429" >&2; cat "${path.join(fixtures, 'claude.jsonl')}"`);
    const res = await createClaudeAdapter(() => bin, () => []).run(req(dir, []));
    expect(res.ok).toBe(true);
    expect(res.limited).toBeNull();
  });

  it('kills the whole process group on timeout', async () => {
    const dir = tmpDir();
    const pidFile = path.join(dir, 'child.pid');
    const bin = script(dir, 'hang', `sleep 60 & echo $! > "${pidFile}"; wait`);
    const t0 = Date.now();
    const res = await runProcess(bin, [], { cwd: dir, timeoutMs: 1500 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('aborts on signal', async () => {
    const dir = tmpDir();
    const bin = script(dir, 'hang2', 'sleep 60');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const res = await createClaudeAdapter(() => bin, () => []).run(req(dir, [], { signal: ctrl.signal }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('stopped by user');
    expect(res.limited).toBeNull();
  });

  it('reports a missing binary', async () => {
    const dir = tmpDir();
    const res = await createClaudeAdapter(() => path.join(dir, 'nope'), () => []).run(req(dir, []));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/failed to start/);
  });
});
