import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mockOptions } from '../src/adapters/mock.js';
import { Engine } from '../src/engine.js';
import type { StoredEvent, WsServerMessage } from '../src/types.js';
import { git, makeEnv, registerProject, runOf, tasksOf, waitFor, waitTasks, type TestEnv } from './helpers/env.js';

let env: TestEnv | null = null;
afterEach(async () => {
  mockOptions.speed = 0.01;
  mockOptions.limitResetSeconds = 60;
  await env?.close().catch(() => {});
  env = null;
});

const FAIL_CMD = 'test ! -f ENSEMBLE_MOCK_FAIL';

describe('phase 1 — single task streams and replays', () => {
  it('streams events over the bus and stores them for replay', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const live: StoredEvent[] = [];
    env.engine.bus.subscribe((m: WsServerMessage) => { if (m.type === 'event') live.push(m.event); });
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] add a greeting' });
    await waitTasks(env, run.id, (ts) => ts.every((t) => t.status === 'awaiting_approval'), 'awaiting approval');
    const stored = env.engine.db.listEvents(run.id, { limit: 5000 });
    const mine = live.filter((e) => e.runId === run.id);
    expect(mine.length).toBeGreaterThan(5);
    expect(stored.map((e) => e.id)).toEqual(mine.map((e) => e.id));
    // paging with ?after
    const after = env.engine.db.listEvents(run.id, { after: stored[2].id });
    expect(after[0].id).toBe(stored[3].id);
    expect(stored.some((e) => e.kind === 'file_change')).toBe(true);
  });
});

describe('phase 2 — worktrees + parallel', () => {
  it('runs t1/t2 in parallel in separate worktrees; t3 gets both parents; main tree untouched', async () => {
    mockOptions.speed = 0.15;
    env = await makeEnv();
    const project = registerProject(env);
    const headBefore = git(env.repo, 'rev-parse', 'HEAD').trim();
    let maxRunning = 0;
    env.engine.bus.subscribe(() => { maxRunning = Math.max(maxRunning, env!.engine.pipeline.activeCount()); });
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: 'build the widget' });
    const ts = await waitTasks(env, run.id, (ts) => ts.length === 3 && ts.every((t) => t.status === 'awaiting_approval'), 'all awaiting', 30_000);
    const [t1, t2, t3] = ['t1', 't2', 't3'].map((k) => ts.find((t) => t.key === k)!);
    expect(t3.dependsOn).toEqual(['t1', 't2']);
    expect(maxRunning).toBeGreaterThanOrEqual(2);
    // t1 and t2 overlapped in time; t3 started after both settled
    const evs = env.engine.db.listEvents(run.id, { limit: 5000 });
    const firstStatus = (taskId: string, status: string) => evs.find((e) => e.taskId === taskId && e.kind === 'status' && e.data?.status === status)!.id;
    expect(firstStatus(t2.id, 'running')).toBeLessThan(firstStatus(t1.id, 'awaiting_approval'));
    expect(firstStatus(t3.id, 'running')).toBeGreaterThan(Math.max(firstStatus(t1.id, 'awaiting_approval'), firstStatus(t2.id, 'awaiting_approval')));
    // separate worktrees
    expect(new Set([t1.worktree, t2.worktree, t3.worktree]).size).toBe(3);
    expect(fs.existsSync(path.join(t1.worktree!, 'src/mock-t1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(t1.worktree!, 'src/mock-t2.txt'))).toBe(false);
    // t3 contains both parents' changes
    expect(fs.existsSync(path.join(t3.worktree!, 'src/mock-t1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(t3.worktree!, 'src/mock-t2.txt'))).toBe(true);
    expect(fs.existsSync(path.join(t3.worktree!, 'src/mock-t3.txt'))).toBe(true);
    // main working tree untouched
    expect(git(env.repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(env.repo, 'status', '--porcelain').trim()).toBe('');
    expect(fs.existsSync(path.join(env.repo, 'src'))).toBe(false);
    expect(runOf(env, run.id).status).toBe('running');
  });

  it('fails dependents when a dependency fails', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: 'x', reviewPlan: true });
    await waitFor(() => runOf(env!, run.id).status === 'plan_review', 10_000, 'plan_review');
    const t1 = tasksOf(env, run.id).find((t) => t.key === 't1')!;
    await env.engine.pipeline.stopTask(t1.id); // pending → stopped
    env.engine.pipeline.startRun(run.id);
    const ts = await waitTasks(env, run.id, (ts) => ts.find((t) => t.key === 't3')!.status === 'failed', 't3 failed');
    expect(ts.find((t) => t.key === 't3')!.error).toBe('dependency t1 did not complete');
  });
});

describe('phase 3 — full pipeline', () => {
  it('(a) test failure → fix → pass', async () => {
    env = await makeEnv();
    const project = registerProject(env, FAIL_CMD);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:fail-test]] add a thing' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    expect(t.attempts).toBe(1);
    expect(t.testStatus).toBe('pass');
    const tests = env.engine.db.listEvents(run.id, { limit: 5000 }).filter((e) => e.kind === 'test').map((e) => e.data?.status);
    expect(tests).toEqual(['fail', 'pass']);
    const outcome = env.engine.db.outcomeStats()[0];
    expect(outcome.passRate).toBe(0);
  });

  it('(a2) retries exhausted → review notes failing tests → awaiting_approval', async () => {
    env = await makeEnv({ maxTestRetries: 1 });
    const project = registerProject(env, 'exit 1');
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] y' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    expect(t.attempts).toBe(1);
    expect(t.testStatus).toBe('fail');
    expect(t.review!.notes[0]).toMatch(/Tests still failing/);
  });

  it('(b) review "changes" → one fix round → awaiting_approval', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:review-changes]] z' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    expect(t.fixRounds).toBe(1);
    expect(t.review!.verdict).toBe('approve');
    const reviews = env.engine.db.listEvents(run.id, { limit: 5000 }).filter((e) => e.kind === 'review').map((e) => e.data?.verdict);
    expect(reviews).toEqual(['changes', 'approve']);
    expect(env.engine.db.outcomeStats()[0].avgCritical).toBe(1);
  });

  it('(c) reviewer is never the author when another provider is available; self-review otherwise', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    for (const goal of ['[[mock:single]] one', '[[mock:single]] two']) {
      const run = await env.engine.pipeline.createRun({ projectId: project.id, goal });
      const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
      expect(t.review!.reviewer.provider).not.toBe(t.provider);
      expect(t.review!.selfReview).toBeUndefined();
    }
    env.engine.updateSettings({ providers: { codex: { enabled: false }, gemini: { enabled: false } } });
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] three' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    expect(t.provider).toBe('claude');
    expect(t.review!.reviewer.provider).toBe('claude');
    expect(t.review!.selfReview).toBe(true);
    expect(t.review!.reviewer.model).not.toBe(t.model);
  });

  it('(d1) limit → handoff to another provider with WIP preserved', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:limit]] w' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    expect(t.handoffs).toBe(1);
    expect(t.provider).not.toBe('codex'); // implement routes to codex first
    const log = git(env.repo, 'log', '--format=%s', t.branch!);
    expect(log).toContain('WIP: interrupted codex');
    const content = fs.readFileSync(path.join(t.worktree!, 'src/mock-t1.txt'), 'utf8');
    expect(content).toMatch(/^WIP from codex\nchange by /);
    expect(env.engine.limits.isLimited('codex')).toBe(true);
    expect(env.engine.db.listEvents(run.id, { limit: 5000 }).some((e) => e.kind === 'limit')).toBe(true);
    expect(t.review!.reviewer.provider).not.toBe(t.provider);
  });

  it('(d2) onLimit "wait" → waiting_limit → resumes after the cooldown', async () => {
    mockOptions.limitResetSeconds = 1;
    env = await makeEnv({ onLimit: 'wait' });
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:limit]] v' });
    await waitTasks(env, run.id, (ts) => ts[0].status === 'waiting_limit', 'waiting_limit');
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting after wait');
    expect(t.handoffs).toBe(0);
    expect(t.provider).toBe('codex');
    const content = fs.readFileSync(path.join(t.worktree!, 'src/mock-t1.txt'), 'utf8');
    expect(content).toMatch(/^WIP from codex\nchange by codex/);
    const statuses = env.engine.db.listEvents(run.id, { limit: 5000 }).filter((e) => e.kind === 'status').map((e) => e.text ?? '');
    expect(statuses.some((s) => s.includes('resumed session'))).toBe(true);
  });

  it('(e) approve merges with --no-ff; a dirty main tree is refused', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] merge me' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    fs.writeFileSync(path.join(env.repo, 'scratch.txt'), 'untracked\n');
    await expect(env.engine.pipeline.approve(t.id)).rejects.toThrow(/uncommitted changes/);
    expect(tasksOf(env, run.id)[0].status).toBe('awaiting_approval');
    fs.rmSync(path.join(env.repo, 'scratch.txt'));
    git(env.repo, 'checkout', '-q', '-b', 'other');
    await expect(env.engine.pipeline.approve(t.id)).rejects.toThrow(/started from "main"/);
    git(env.repo, 'checkout', '-q', 'main');
    const merged = await env.engine.pipeline.approve(t.id);
    expect(merged.status).toBe('merged');
    const parents = git(env.repo, 'log', '-1', '--format=%P').trim().split(' ');
    expect(parents).toHaveLength(2);
    expect(git(env.repo, 'log', '-1', '--format=%s').trim()).toBe(`Ensemble: ${t.title}`);
    expect(fs.existsSync(path.join(env.repo, 'src/mock-t1.txt'))).toBe(true);
    await waitFor(() => runOf(env!, run.id).status === 'done', 5000, 'run done');
    expect(env.engine.db.outcomeStats()[0].approvalRate).toBe(1);
    // no push ever: there is no remote, and the branch is kept until "Clean up branches"
    expect(git(env.repo, 'branch', '--list', t.branch!).trim()).not.toBe('');
    await env.engine.pipeline.cleanupRun(run.id, { mergedBranches: true });
    expect(git(env.repo, 'branch', '--list', t.branch!).trim()).toBe('');
  });

  it('(e2) merge conflict keeps the task awaiting and rebase recovers', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] conflict' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    fs.mkdirSync(path.join(env.repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(env.repo, 'src/mock-t1.txt'), 'conflicting content on main\n');
    git(env.repo, 'add', '-A');
    git(env.repo, 'commit', '-q', '-m', 'main change');
    const err = await env.engine.pipeline.approve(t.id).catch((e) => e);
    expect(err.message).toMatch(/Merge conflict/);
    expect(err.extra.conflicts).toEqual(['src/mock-t1.txt']);
    expect(git(env.repo, 'status', '--porcelain').trim()).toBe('');
    expect(tasksOf(env, run.id)[0].status).toBe('awaiting_approval');
    // Rebase also conflicts here (same lines) — it must refuse cleanly.
    await expect(env.engine.pipeline.rebase(t.id)).rejects.toThrow(/Conflicts while rebasing/);
    expect(tasksOf(env, run.id)[0].status).toBe('awaiting_approval');
  });

  it('(e3) rebase onto a moved base branch re-runs tests + review', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] rebase' });
    const [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    fs.writeFileSync(path.join(env.repo, 'OTHER.md'), 'unrelated\n');
    git(env.repo, 'add', '-A');
    git(env.repo, 'commit', '-q', '-m', 'unrelated main change');
    await env.engine.pipeline.rebase(t.id);
    const [t2] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval' && ts[0].branch !== t.branch, 'awaiting after rebase');
    expect(t2.branch).toMatch(/-r1$/);
    const d = await env.engine.pipeline.diff(t2.id);
    expect(d.stat).toContain('src/mock-t1.txt');
    expect(d.stat).not.toContain('OTHER.md');
    expect((await env.engine.pipeline.approve(t2.id)).status).toBe('merged');
  });

  it('(f) restart marks in-flight tasks failed and Retry works', async () => {
    mockOptions.speed = 2;
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] restart me' });
    await waitTasks(env, run.id, (ts) => ts[0].status === 'running', 'running');
    const { root } = env;
    await env.engine.shutdown(); // like a crash: in-flight state left as-is
    mockOptions.speed = 0.01;
    const engine2 = new Engine({ config: env.engine.config, dataDir: path.join(root, 'data'), demo: true, tickMs: 50, limitGraceMs: 0, persistConfig: false });
    await engine2.start();
    env = { ...env, engine: engine2, close: () => engine2.shutdown() };
    let [t] = tasksOf(env, run.id);
    expect(t.status).toBe('failed');
    expect(t.error).toBe('interrupted by restart');
    expect(runOf(env, run.id).status).toBe('running');
    engine2.pipeline.retry(t.id);
    [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting after retry');
    expect(t.attempts).toBe(0);
  });

  it('retry / reassign with feedback after reject', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] reassign' });
    let [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting');
    env.engine.pipeline.reject(t.id, 'wrong file');
    await waitFor(() => runOf(env!, run.id).status === 'done', 5000, 'done after reject');
    env.engine.pipeline.retry(t.id, { provider: 'gemini', model: '', instructions: 'use the other file' });
    expect(runOf(env, run.id).status).toBe('running');
    [t] = await waitTasks(env, run.id, (ts) => ts[0].status === 'awaiting_approval', 'awaiting after reassign');
    expect(t.provider).toBe('gemini');
    expect(t.feedback).toContain('use the other file');
    expect(t.feedback).toContain('wrong file');
  });

  it('no-changes tasks end as no_changes', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:no-changes]] noop' });
    await waitTasks(env, run.id, (ts) => ts[0].status === 'no_changes', 'no_changes');
    await waitFor(() => runOf(env!, run.id).status === 'done', 5000, 'done');
  });

  it('planning retries once on invalid JSON', async () => {
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: '[[mock:single]] [[mock:bad-plan]] p' });
    await waitTasks(env, run.id, (ts) => ts.length === 1, 'plan');
    const logs = env.engine.db.listEvents(run.id, { limit: 5000 }).filter((e) => e.kind === 'log').map((e) => e.text);
    expect(logs.some((l) => l?.includes('could not be parsed'))).toBe(true);
  });

  it('plan review lets the user edit before start; stop aborts everything', async () => {
    mockOptions.speed = 1;
    env = await makeEnv();
    const project = registerProject(env);
    const run = await env.engine.pipeline.createRun({ projectId: project.id, goal: 'edit plan', reviewPlan: true });
    await waitFor(() => runOf(env!, run.id).status === 'plan_review', 10_000, 'plan_review');
    const t2 = tasksOf(env, run.id).find((t) => t.key === 't2')!;
    const edited = env.engine.pipeline.patchTask(t2.id, { title: 'Edited', provider: 'gemini', model: 'x', dependsOn: ['t1'] });
    expect(edited).toMatchObject({ title: 'Edited', provider: 'gemini', model: 'x', dependsOn: ['t1'] });
    expect(() => env!.engine.pipeline.patchTask(t2.id, { dependsOn: ['t3'] })).toThrow(/cycle/);
    env.engine.pipeline.startRun(run.id);
    await waitTasks(env, run.id, (ts) => ts.some((t) => t.status === 'running'), 'running');
    await env.engine.pipeline.stopRun(run.id);
    expect(runOf(env, run.id).status).toBe('stopped');
    expect(tasksOf(env, run.id).every((t) => t.status === 'stopped')).toBe(true);
  });
});
