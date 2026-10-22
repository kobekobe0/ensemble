// Fastify app: REST API (§13), WebSocket (§13.2), static dashboard, security checks (§16).
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendNtfy } from './bus.js';
import { VERSION } from './config.js';
import type { Engine } from './engine.js';
import { FsError, listDir, listRoots, resolveAllowed } from './fsbrowse.js';
import * as G from './git.js';
import { UserError } from './pipeline.js';
import { agentFiles, detectStack, writeAgentsMd } from './projects.js';
import type { RealProviderId, WsServerMessage } from './types.js';
import { REAL_PROVIDERS } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIST = path.resolve(here, '../../web/dist');

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

export interface ServerOptions {
  /** extra allowed Origin hostnames (e.g. the Tailscale name); *.ts.net is always allowed */
  allowedOriginHosts?: string[];
  token?: string | null;
  logger?: boolean;
}

export async function buildServer(engine: Engine, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const token = opts.token ?? process.env.ENSEMBLE_TOKEN ?? null;
  const requireToken = !isLoopback(engine.config.host);
  if (requireToken && !token) {
    throw new Error(`host is ${engine.config.host}; set ENSEMBLE_TOKEN to require a bearer token for remote clients.`);
  }

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  // ---- security: Origin check + optional bearer token -------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    // Host check defeats DNS rebinding (attacker domain resolving to 127.0.0.1).
    if (!hostAllowed(req.headers.host, engine.config.host, opts.allowedOriginHosts ?? [])) {
      return reply.code(403).send({ error: 'unexpected Host header' });
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host, opts.allowedOriginHosts ?? [])) {
      return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
    if (requireToken && (req.url.startsWith('/api') || req.url.startsWith('/ws'))) {
      const fromHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const fromQuery = (req.query as Record<string, string> | undefined)?.token;
      const given = fromHeader || fromQuery || '';
      if (!safeEqual(given, token!)) return reply.code(401).send({ error: 'missing or invalid token' });
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof UserError || err instanceof FsError ? err.status : err.status ?? err.statusCode ?? 500;
    const body: Record<string, unknown> = { error: err.message ?? String(err) };
    if (err instanceof UserError && err.extra) Object.assign(body, err.extra);
    if (status >= 500) console.error(err);
    reply.code(status).send(body);
  });

  const db = engine.db;
  const pipe = engine.pipeline;
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new UserError(`${what} not found`, 404);
    return v;
  };

  // ---- health / fs ------------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, version: VERSION, demo: engine.demo, remote: requireToken }));

  app.get('/api/fs', async (req) => {
    const q = req.query as { path?: string; hidden?: string };
    if (!q.path) return { path: null, parent: null, entries: listRoots(engine.config.allowedRoots), isGitRepo: false, roots: true };
    return listDir(q.path, engine.config.allowedRoots, q.hidden === '1' || q.hidden === 'true');
  });

  // ---- projects ---------------------------------------------------------------------------
  app.get('/api/projects', async () => db.listProjects());

  const registerProject = async (input: string) => {
    const dir = resolveAllowed(input, engine.config.allowedRoots);
    const top = await G.toplevel(dir);
    if (!top) throw new UserError(`${dir} is not a git repository`, 400, { notGit: true, path: dir });
    const root = fs.realpathSync(top);
    resolveAllowed(root, engine.config.allowedRoots);
    const stack = detectStack(root);
    const existing = db.listProjects().find((p) => p.path === root);
    const project = db.upsertProject({
      path: root, name: path.basename(root), stack,
      testCommand: existing?.testCommand ?? stack.suggestedTest, setupCommand: existing?.setupCommand ?? stack.suggestedSetup,
      linkNodeModules: existing?.linkNodeModules ?? true,
    });
    return project;
  };

  app.post('/api/projects', async (req) => {
    const body = (req.body ?? {}) as { path?: string };
    return registerProject(String(body.path ?? ''));
  });

  app.post('/api/projects/init', async (req) => {
    const body = (req.body ?? {}) as { path?: string };
    const dir = resolveAllowed(String(body.path ?? ''), engine.config.allowedRoots);
    if (await G.toplevel(dir)) throw new UserError('already a git repository');
    await G.initRepo(dir);
    return registerProject(dir);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    need(db.getProject(id), 'project');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['testCommand', 'setupCommand'] as const) {
      if (k in b) {
        if (b[k] !== null && typeof b[k] !== 'string') throw new UserError(`${k} must be a string or null`);
        patch[k] = typeof b[k] === 'string' && !(b[k] as string).trim() ? null : b[k];
      }
    }
    if ('linkNodeModules' in b) {
      if (typeof b.linkNodeModules !== 'boolean') throw new UserError('linkNodeModules must be a boolean');
      patch.linkNodeModules = b.linkNodeModules;
    }
    if ('name' in b) {
      if (typeof b.name !== 'string' || !b.name.trim()) throw new UserError('name must be a non-empty string');
      patch.name = b.name.trim();
    }
    return db.updateProject(id, patch);
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    need(db.getProject(id), 'project');
    for (const r of db.listRuns(id, true)) await pipe.deleteRun(r.id).catch(() => db.deleteRun(r.id));
    db.deleteProject(id);
    return { ok: true };
  });

  app.get('/api/projects/:id/info', async (req) => {
    const { id } = req.params as { id: string };
    const p = need(db.getProject(id), 'project');
    const repo = !!(await G.toplevel(p.path).catch(() => null));
    const status = repo ? await G.statusPorcelain(p.path).catch(() => []) : [];
    const refreshed = pipe.refreshStack(p);
    return {
      project: refreshed,
      exists: fs.existsSync(p.path),
      isGitRepo: repo,
      branch: repo ? await G.currentBranch(p.path).catch(() => null) : null,
      dirty: status.length > 0,
      dirtyFiles: status.slice(0, 50),
      agentFiles: agentFiles(p.path),
    };
  });

  app.post('/api/projects/:id/agents-md/draft', async (req) => {
    const { id } = req.params as { id: string };
    need(db.getProject(id), 'project');
    return pipe.draftAgentsMd(id);
  });

  app.put('/api/projects/:id/agents-md', async (req) => {
    const { id } = req.params as { id: string };
    const p = need(db.getProject(id), 'project');
    const b = (req.body ?? {}) as { content?: unknown; linkAliases?: unknown };
    if (typeof b.content !== 'string' || !b.content.trim()) throw new UserError('content is required');
    const written = writeAgentsMd(p.path, b.content, b.linkAliases === true);
    return { ok: true, written, agentFiles: agentFiles(p.path) };
  });

  // ---- runs -------------------------------------------------------------------------------
  app.get('/api/runs', async (req) => {
    const { projectId } = req.query as { projectId?: string };
    return db.listRuns(projectId).map((r) => {
      const tasks = db.listTasks(r.id);
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return { ...r, taskCount: tasks.length, taskCounts: counts };
    });
  });

  app.post('/api/runs', async (req) => {
    const b = (req.body ?? {}) as { projectId?: string; goal?: string; lead?: { provider?: string; model?: string }; reviewPlan?: boolean };
    let lead;
    if (b.lead) {
      if (!REAL_PROVIDERS.includes(b.lead.provider as RealProviderId)) throw new UserError('lead.provider must be claude|codex|gemini');
      lead = { provider: b.lead.provider as RealProviderId, model: String(b.lead.model ?? '') };
    }
    return pipe.createRun({ projectId: String(b.projectId ?? ''), goal: String(b.goal ?? ''), lead, reviewPlan: typeof b.reviewPlan === 'boolean' ? b.reviewPlan : undefined });
  });

  app.get('/api/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = need(db.getRun(id), 'run');
    return { run, tasks: db.listTasks(id), project: db.getProject(run.projectId) };
  });

  app.get('/api/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    need(db.getRun(id), 'run');
    const q = req.query as { after?: string; taskId?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 1000, 5000);
    const events = db.listEvents(id, { after: Number(q.after) || 0, taskId: q.taskId || undefined, limit });
    return { events, more: events.length === limit };
  });

  app.post('/api/runs/:id/start', async (req) => pipe.startRun((req.params as { id: string }).id));
  app.post('/api/runs/:id/pause', async (req) => pipe.pauseRun((req.params as { id: string }).id));
  app.post('/api/runs/:id/resume', async (req) => pipe.resumeRun((req.params as { id: string }).id));
  app.post('/api/runs/:id/stop', async (req) => pipe.stopRun((req.params as { id: string }).id));
  app.post('/api/runs/:id/cleanup-branches', async (req) => {
    const { id } = req.params as { id: string };
    need(db.getRun(id), 'run');
    await pipe.cleanupRun(id, { mergedBranches: true });
    return { ok: true, tasks: db.listTasks(id) };
  });
  app.delete('/api/runs/:id', async (req) => {
    await pipe.deleteRun((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- tasks ------------------------------------------------------------------------------
  app.patch('/api/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    return pipe.patchTask(id, (req.body ?? {}) as any);
  });
  app.get('/api/tasks/:id/diff', async (req) => pipe.diff((req.params as { id: string }).id));
  app.post('/api/tasks/:id/approve', async (req) => pipe.approve((req.params as { id: string }).id));
  app.post('/api/tasks/:id/reject', async (req) => {
    const b = (req.body ?? {}) as { reason?: string };
    return pipe.reject((req.params as { id: string }).id, typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : undefined);
  });
  app.post('/api/tasks/:id/retry', async (req) => {
    const b = (req.body ?? {}) as { provider?: RealProviderId; model?: string; instructions?: string };
    return pipe.retry((req.params as { id: string }).id, {
      provider: b.provider || undefined, model: typeof b.model === 'string' ? b.model : undefined,
      instructions: typeof b.instructions === 'string' ? b.instructions : undefined,
    });
  });
  app.post('/api/tasks/:id/rebase', async (req) => pipe.rebase((req.params as { id: string }).id));
  app.post('/api/tasks/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    await pipe.stopTask(id);
    return db.getTask(id);
  });

  // ---- providers / settings / routing -------------------------------------------------------
  app.get('/api/providers', async () => engine.providerStatuses());
  app.post('/api/providers/refresh', async () => { await engine.adapters.refresh(); engine.broadcastProviders(); return engine.providerStatuses(); });

  app.post('/api/providers/:id/limit', async (req) => {
    const { id } = req.params as { id: RealProviderId };
    if (!REAL_PROVIDERS.includes(id)) throw new UserError('unknown provider', 404);
    const b = (req.body ?? {}) as { until?: number | string };
    const until = typeof b.until === 'string' ? Date.parse(b.until) : Number(b.until);
    if (!Number.isFinite(until) || until <= Date.now()) throw new UserError('until must be a future time (epoch ms or ISO string)');
    engine.limits.setManual(id, until);
    engine.broadcastProviders();
    return engine.providerStatuses();
  });
  app.delete('/api/providers/:id/limit', async (req) => {
    const { id } = req.params as { id: RealProviderId };
    if (!REAL_PROVIDERS.includes(id)) throw new UserError('unknown provider', 404);
    engine.limits.clear(id);
    engine.broadcastProviders();
    engine.scheduler.kick();
    return engine.providerStatuses();
  });

  app.get('/api/settings', async () => engine.config);
  app.put('/api/settings', async (req) => engine.updateSettings(req.body ?? {}));
  app.post('/api/settings/test-notification', async () => {
    const topic = engine.config.ntfyTopic;
    engine.bus.broadcast({ type: 'notify', title: 'Ensemble test notification', body: 'Notifications are working.' });
    if (!topic) return { ok: true, ntfy: false };
    const ok = await sendNtfy(topic, 'Ensemble test notification', 'Push notifications are working.');
    if (!ok) throw new UserError('ntfy.sh did not accept the notification', 502);
    return { ok: true, ntfy: true };
  });
  app.get('/api/routing/stats', async () => engine.router.stats());

  // ---- WebSocket ----------------------------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket, req) => {
    let filter: string | null = null;
    const send = (msg: WsServerMessage) => {
      if (socket.readyState !== 1) return;
      if (filter && msg.type === 'event' && msg.event.runId !== filter) return;
      socket.send(JSON.stringify(msg));
    };
    send({ type: 'hello', serverTime: Date.now(), demo: engine.demo });
    send({ type: 'providers', providers: engine.providerStatuses() });
    const unsub = engine.bus.subscribe(send);
    let alive = true;
    socket.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      try { socket.ping(); } catch { /* closed */ }
    }, 25_000);
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.type === 'subscribe') filter = typeof m.runId === 'string' && m.runId ? m.runId : null;
      } catch { /* ignore garbage */ }
    });
    socket.on('close', () => { clearInterval(ping); unsub(); });
    void req;
  });

  // ---- static dashboard ---------------------------------------------------------------------
  if (fs.existsSync(WEB_DIST)) {
    // wildcard routing (the default) so files from a rebuild are served without a restart
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/', index: ['index.html'] });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      const pathname = req.url.split('?')[0];
      // SPA fallback for client routes only — a missing /assets/x.js must 404, not return HTML.
      if (req.method === 'GET' && !pathname.startsWith('/api') && !pathname.startsWith('/ws') && !/\.[a-z0-9]+$/i.test(pathname)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<p>Dashboard not built. Run <code>pnpm build</code>.</p>'));
  }

  return app;
}

function originAllowed(origin: string, hostHeader: string | undefined, extraHosts: string[]): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (hostHeader && u.host === hostHeader) return true;           // same origin (incl. via tailscale serve, which preserves Host)
  if (u.hostname.endsWith('.ts.net')) return true;                // Tailscale MagicDNS names
  if (extraHosts.includes(u.hostname)) return true;
  // Vite dev server (pnpm dev) on localhost:5173 proxies to us.
  if (isLoopback(u.hostname) && u.port === '5173' && hostHeader && isLoopback(hostname(hostHeader))) return true;
  return false;
}

function hostname(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']'));
  return hostHeader.split(':')[0];
}

function hostAllowed(hostHeader: string | undefined, bindHost: string, extraHosts: string[]): boolean {
  if (!hostHeader) return true; // HTTP/1.0 clients; Origin check still applies
  const h = hostname(hostHeader).toLowerCase();
  return isLoopback(h) || h.endsWith('.ts.net') || h === bindHost || extraHosts.includes(h) || /^100\.\d+\.\d+\.\d+$/.test(h);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
