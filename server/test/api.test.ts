import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeEnv, makeRepo, waitFor, type TestEnv } from './helpers/env.js';

let env: TestEnv | null = null;
afterEach(async () => { await env?.close().catch(() => {}); env = null; });

async function setup() {
  env = await makeEnv();
  const app = await buildServer(env.engine);
  return { env, app };
}

describe('API', () => {
  it('health + same-origin/Host checks', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ ok: true, demo: true });
    expect((await app.inject({ url: '/api/health', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example:4317' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example:4317', origin: 'http://evil.example:4317' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health', headers: { host: 'mac.tail1234.ts.net', origin: 'https://mac.tail1234.ts.net' } })).statusCode).toBe(200);
  });

  it('folder browser is confined to allowed roots', async () => {
    const { env, app } = await setup();
    const roots = (await app.inject({ url: '/api/fs' })).json();
    expect(roots.entries[0].path).toBe(env.root);
    const list = (await app.inject({ url: `/api/fs?path=${encodeURIComponent(env.root)}` })).json();
    expect(list.entries.find((e: any) => e.name === 'repo')).toMatchObject({ isGitRepo: true });
    expect((await app.inject({ url: '/api/fs?path=/etc' })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/fs?path=${encodeURIComponent(env.root + '/../')}` })).statusCode).toBe(403);
    fs.symlinkSync('/etc', path.join(env.root, 'escape'));
    expect((await app.inject({ url: `/api/fs?path=${encodeURIComponent(path.join(env.root, 'escape'))}` })).statusCode).toBe(403);
    expect(list.entries.some((e: any) => e.name === 'escape')).toBe(false);
  });

  it('project registration, stack detection, init', async () => {
    const { env, app } = await setup();
    fs.writeFileSync(path.join(env.repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vite: '1', react: '1' } }));
    fs.writeFileSync(path.join(env.repo, 'pnpm-lock.yaml'), '');
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { path: env.repo } })).json();
    expect(p.stack.kinds).toEqual(expect.arrayContaining(['node', 'react', 'vite']));
    expect(p.testCommand).toBe('pnpm test');
    const info = (await app.inject({ url: `/api/projects/${p.id}/info` })).json();
    expect(info).toMatchObject({ branch: 'main', dirty: true });
    const patched = (await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { testCommand: 'true', linkNodeModules: false } })).json();
    expect(patched).toMatchObject({ testCommand: 'true', linkNodeModules: false });
    const plain = path.join(env.root, 'plain');
    fs.mkdirSync(plain);
    const notGit = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: plain } });
    expect(notGit.statusCode).toBe(400);
    expect(notGit.json().notGit).toBe(true);
    const inited = await app.inject({ method: 'POST', url: '/api/projects/init', payload: { path: plain } });
    expect(inited.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/projects' })).json()).toHaveLength(2);
  });

  it('settings validation rejects unknown keys and bad types', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { bogus: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxParallel: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { providers: { codex: { nope: true } } } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxParallel: 3, providers: { codex: { extraArgs: ['--full-auto'] } } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().maxParallel).toBe(3);
    expect(ok.json().providers.codex.extraArgs).toEqual(['--full-auto']);
    expect(ok.json().providers.codex.bin).toBe('codex'); // deep merge kept siblings
  });

  it('runs end to end over HTTP', async () => {
    const { env, app } = await setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { path: env.repo } })).json();
    const run = (await app.inject({ method: 'POST', url: '/api/runs', payload: { projectId: p.id, goal: '[[mock:single]] api run' } })).json();
    await waitFor(() => env.engine.db.listTasks(run.id)[0]?.status === 'awaiting_approval', 15_000, 'awaiting');
    const detail = (await app.inject({ url: `/api/runs/${run.id}` })).json();
    const task = detail.tasks[0];
    const diff = (await app.inject({ url: `/api/tasks/${task.id}/diff` })).json();
    expect(diff.diff).toContain('src/mock-t1.txt');
    const events = (await app.inject({ url: `/api/runs/${run.id}/events?after=0&limit=5` })).json();
    expect(events.events).toHaveLength(5);
    expect(events.more).toBe(true);
    const approved = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve` });
    expect(approved.json().status).toBe('merged');
    const providers = (await app.inject({ url: '/api/providers' })).json();
    expect(providers.map((x: any) => x.id)).toEqual(['claude', 'codex', 'gemini']);
    expect(providers.some((x: any) => x.usage5h.calls > 0)).toBe(true);
    const limited = await app.inject({ method: 'POST', url: '/api/providers/codex/limit', payload: { until: Date.now() + 60_000 } });
    expect(limited.json().find((x: any) => x.id === 'codex').limitedUntil).toBeGreaterThan(Date.now());
    await app.inject({ method: 'DELETE', url: '/api/providers/codex/limit' });
    expect((await app.inject({ url: '/api/routing/stats' })).json()[0]).toMatchObject({ n: 1 });
    expect((await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}` })).statusCode).toBe(200);
  });

  it('refuses to start from a detached HEAD', async () => {
    const { env, app } = await setup();
    const repo2 = makeRepo(env.root, 'detached');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo2 });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo2 } })).json();
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { projectId: p.id, goal: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/detached/);
  });

  it('requires a token when bound beyond loopback', async () => {
    env = await makeEnv({ host: '0.0.0.0' });
    await expect(buildServer(env.engine, { token: null })).rejects.toThrow(/ENSEMBLE_TOKEN/);
    const app = await buildServer(env.engine, { token: 's3cret' });
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health', headers: { authorization: 'Bearer s3cret' } })).statusCode).toBe(200);
  });
});
