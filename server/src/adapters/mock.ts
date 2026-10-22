// Fake agent for tests and demo mode (§6.6, §12).
// Scripted behaviours via markers anywhere in the prompt (the goal is part of every prompt):
//   [[mock:single]]          plan has a single task (default plan: t1, t2 independent; t3 depends on both)
//   [[mock:fail-test]]       work creates ENSEMBLE_MOCK_FAIL (use test command `test ! -f ENSEMBLE_MOCK_FAIL`); fix removes it
//   [[mock:limit]]           first work call in a worktree hits a usage limit (after writing partial WIP)
//   [[mock:review-changes]]  first review of a worktree asks for changes with one critical issue
//   [[mock:no-changes]]      work makes no file changes
//   [[mock:bad-plan]]        the first planning reply is not valid JSON
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, ProviderId } from '../types.js';
import type { Adapter, AgentRequest, AgentResult } from './base.js';

export const mockOptions = {
  /** Multiplier for the 200–800 ms delays (tests use ~0.02). */
  speed: Number(process.env.ENSEMBLE_MOCK_SPEED) > 0 ? Number(process.env.ENSEMBLE_MOCK_SPEED) : 1,
  /** Reset time reported by [[mock:limit]]. */
  limitResetSeconds: 60,
};

const state = new Map<string, { limited: boolean; reviews: number; plans: number }>();
const st = (k: string) => {
  let s = state.get(k);
  if (!s) { s = { limited: false, reviews: 0, plans: 0 }; state.set(k, s); }
  return s;
};

const has = (prompt: string, marker: string) => prompt.includes(`[[mock:${marker}]]`);
/** Resumed sessions "remember" their earlier prompts, like the real CLIs. */
const sessions = new Map<string, string>();

function goalOf(prompt: string): string {
  const m = prompt.match(/## Goal\n([\s\S]*?)\n## /);
  return (m?.[1] ?? prompt).trim();
}

function planFor(prompt: string) {
  const goal = goalOf(prompt);
  const short = goal.replace(/\[\[mock:[^\]]*\]\]/g, '').trim().slice(0, 60) || 'the goal';
  if (has(prompt, 'single')) {
    return {
      summary: `Single change for: ${short}`,
      tasks: [{ key: 't1', title: `Implement ${short}`, description: `Make the change described by the goal: ${short}. Acceptance: the change is present and tests pass.`, type: 'implement', size: 'small', dependsOn: [], suggestedProvider: null }],
    };
  }
  return {
    summary: `Three-step plan for: ${short}`,
    tasks: [
      { key: 't1', title: 'Core implementation', description: `Implement the core of: ${short}. Files: src/. Acceptance: feature works.`, type: 'implement', size: 'medium', dependsOn: [], suggestedProvider: null },
      { key: 't2', title: 'Tests', description: `Add tests covering: ${short}. Acceptance: tests pass.`, type: 'tests', size: 'small', dependsOn: [], suggestedProvider: null },
      { key: 't3', title: 'Docs', description: `Document the change: ${short}. Acceptance: README mentions it.`, type: 'docs', size: 'small', dependsOn: ['t1', 't2'], suggestedProvider: null },
    ],
  };
}

export function createMockAdapter(id: ProviderId, label: string = id): Adapter {
  return {
    id,
    async available() { return { installed: true, version: `mock (${label})` }; },
    async run(req: AgentRequest): Promise<AgentResult> {
      const started = Date.now();
      const deadline = started + req.timeoutMs;
      const sessionId = req.resumeSessionId ?? `mock-${label}-${Math.random().toString(36).slice(2, 10)}`;
      const history = (req.resumeSessionId && sessions.get(req.resumeSessionId)) || '';
      sessions.set(sessionId, history + '\n' + req.prompt);
      req = { ...req, prompt: history ? `${history}\n${req.prompt}` : req.prompt };
      const ev = (e: AgentEvent) => { try { req.onEvent(e); } catch { /* ignore */ } };
      const base = { sessionId, inputTokens: 0, outputTokens: 0, limited: null } as const;
      const stopped = (): AgentResult | null => {
        if (req.signal.aborted) return { ...base, ok: false, finalText: '', durationMs: Date.now() - started, error: 'stopped by user' };
        if (Date.now() > deadline) return { ...base, ok: false, finalText: '', durationMs: Date.now() - started, error: 'timed out' };
        return null;
      };
      const sleep = async () => {
        const ms = (200 + Math.random() * 600) * mockOptions.speed;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          req.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return stopped();
      };
      const done = (finalText: string, extra: Partial<AgentResult> = {}): AgentResult => {
        const inputTokens = Math.round(req.prompt.length / 4);
        const outputTokens = Math.round(finalText.length / 4) + 50;
        ev({ kind: 'usage', text: `in ${inputTokens} · out ${outputTokens}`, data: { inputTokens, outputTokens } });
        return { ...base, ok: true, finalText, inputTokens, outputTokens, durationMs: Date.now() - started, error: null, ...extra };
      };

      ev({ kind: 'system', text: `session ${sessionId} · model ${req.model || 'default'} (mock ${label})`, data: { sessionId, model: req.model } });
      let s = await sleep(); if (s) return s;
      const role = req.role ?? (req.readOnly ? 'review' : 'work');
      const key = req.taskKey ?? path.basename(req.cwd);
      const wt = st(req.cwd);

      if (role === 'plan') {
        ev({ kind: 'thinking', text: 'Reading the repository layout and the goal…' });
        ev({ kind: 'tool', text: 'Glob **/*', data: { name: 'Glob' } });
        s = await sleep(); if (s) return s;
        const plans = st(`plan:${goalOf(req.prompt)}`);
        plans.plans++;
        if (has(req.prompt, 'bad-plan') && plans.plans === 1) {
          ev({ kind: 'text', text: 'Here is my plan: do the thing.' });
          return done('Here is my plan: do the thing.');
        }
        const text = '```json\n' + JSON.stringify(planFor(req.prompt), null, 2) + '\n```';
        ev({ kind: 'text', text });
        return done(text);
      }

      if (role === 'review') {
        ev({ kind: 'thinking', text: 'Reading the diff and the task description…' });
        s = await sleep(); if (s) return s;
        wt.reviews++;
        const changes = has(req.prompt, 'review-changes') && wt.reviews === 1;
        const verdict = changes
          ? { verdict: 'changes', critical: ['Mock critical issue: missing input validation.'], notes: ['Consider a clearer name.'] }
          : { verdict: 'approve', critical: [], notes: ['Looks good (mock review).'] };
        const text = '```json\n' + JSON.stringify(verdict, null, 2) + '\n```';
        ev({ kind: 'text', text });
        return done(text);
      }

      if (role === 'agents_md') {
        s = await sleep(); if (s) return s;
        const text = '# AGENTS.md\n\n## Stack\n- (mock) Detected from the repository\n\n## Build & test\n- `npm test`\n\n## Conventions\n- Keep changes small.\n';
        ev({ kind: 'text', text });
        return done(text);
      }

      // work / fix
      ev({ kind: 'thinking', text: role === 'fix' ? 'Looking at what needs fixing…' : 'Planning the change…' });
      ev({ kind: 'tool', text: 'Read README.md', data: { name: 'Read', input: { file_path: 'README.md' } } });
      s = await sleep(); if (s) return s;
      ev({ kind: 'command', text: 'ls', data: { command: 'ls', status: 'completed', exitCode: 0, output: safeLs(req.cwd) } });
      s = await sleep(); if (s) return s;

      const rel = path.join('src', `mock-${key}.txt`);
      const file = path.join(req.cwd, rel);
      const failFile = path.join(req.cwd, 'ENSEMBLE_MOCK_FAIL');

      if (role === 'work' && has(req.prompt, 'limit') && !wt.limited) {
        wt.limited = true;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `WIP from ${label}\n`);
        ev({ kind: 'file_change', text: rel, data: { path: rel } });
        const message = `You've hit your usage limit. Try again in ${mockOptions.limitResetSeconds} seconds.`;
        ev({ kind: 'error', text: message });
        return {
          ...base, ok: false, finalText: 'Started the change (WIP).', durationMs: Date.now() - started, error: message,
          limited: { resetAt: Date.now() + mockOptions.limitResetSeconds * 1000, message },
        };
      }

      if (role === 'work' && has(req.prompt, 'no-changes')) {
        const text = 'No changes were needed — the requested behaviour already exists.';
        ev({ kind: 'text', text });
        return done(text);
      }

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${role === 'fix' ? 'fix' : 'change'} by ${label}${req.model ? '/' + req.model : ''} at ${new Date().toISOString()}\n`);
      ev({ kind: 'file_change', text: rel, data: { path: rel } });
      if (role === 'work' && has(req.prompt, 'fail-test')) {
        fs.writeFileSync(failFile, 'mock failure marker\n');
        ev({ kind: 'file_change', text: 'ENSEMBLE_MOCK_FAIL', data: { path: 'ENSEMBLE_MOCK_FAIL' } });
      }
      if (role === 'fix' && fs.existsSync(failFile)) {
        fs.rmSync(failFile);
        ev({ kind: 'file_change', text: 'ENSEMBLE_MOCK_FAIL (deleted)', data: { path: 'ENSEMBLE_MOCK_FAIL', change: 'delete' } });
      }
      s = await sleep(); if (s) return s;
      const text = role === 'fix'
        ? `Fixed the reported problems.\n\nFiles touched: ${rel}`
        : `Implemented the task.\n\nFiles touched: ${rel}\nNothing left undone.`;
      ev({ kind: 'text', text });
      return done(text);
    },
  };
}

function safeLs(dir: string): string {
  try { return fs.readdirSync(dir).join('\n'); } catch { return ''; }
}
