// Wires config, DB, bus, adapters and the pipeline together. Used by the server and by tests.
import fs from 'node:fs';
import path from 'node:path';
import { AdapterRegistry, type Adapter } from './adapters/index.js';
import { Bus } from './bus.js';
import { dataDir, deepMerge, isDemo, loadConfig, saveConfig, validateSettings } from './config.js';
import { Db } from './db.js';
import * as G from './git.js';
import { KeepAwake } from './keepawake.js';
import { Limits } from './limits.js';
import { Pipeline } from './pipeline.js';
import { Router } from './router.js';
import { Scheduler } from './scheduler.js';
import type { Config, ProviderStatus, RealProviderId } from './types.js';
import { REAL_PROVIDERS } from './types.js';

export interface EngineOptions {
  config?: Config;
  /** persist settings changes to ~/.ensemble/config.json (off in tests) */
  persistConfig?: boolean;
  dataDir?: string;
  demo?: boolean;
  adapters?: Partial<Record<RealProviderId, Adapter>>;
  tickMs?: number;
  limitGraceMs?: number;
  availabilityRefreshMs?: number;
}

export class Engine {
  config: Config;
  readonly demo: boolean;
  readonly db: Db;
  readonly bus: Bus;
  readonly adapters: AdapterRegistry;
  readonly limits: Limits;
  readonly router: Router;
  readonly pipeline: Pipeline;
  readonly scheduler: Scheduler;
  private keepAwake = new KeepAwake();
  private availTimer: NodeJS.Timeout | null = null;
  private providersTimer: NodeJS.Timeout | null = null;
  private persist: boolean;
  private availabilityRefreshMs: number;

  constructor(opts: EngineOptions = {}) {
    this.demo = opts.demo ?? isDemo();
    this.config = opts.config ?? loadConfig();
    this.persist = opts.persistConfig ?? !opts.config;
    const dir = opts.dataDir ?? dataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.config.worktreeDir, { recursive: true });
    this.db = new Db(path.join(dir, 'ensemble.db'));
    this.bus = new Bus(this.db);
    this.bus.ntfyTopic = () => this.config.ntfyTopic;
    const cfg = () => this.config;
    this.adapters = new AdapterRegistry(cfg, this.demo, opts.adapters);
    this.limits = new Limits(this.db, this.bus, cfg);
    this.router = new Router(cfg, this.db, this.adapters, this.limits);
    this.pipeline = new Pipeline(cfg, this.db, this.bus, this.adapters, this.limits, this.router, { limitGraceMs: opts.limitGraceMs ?? 60_000 });
    this.scheduler = new Scheduler(cfg, this.db, this.pipeline, this.limits, this.adapters, opts.tickMs ?? 2000);
    this.pipeline.kick = () => { this.scheduler.kick(); this.updateKeepAwake(); };
    this.pipeline.onProvidersChanged = () => this.broadcastProvidersSoon();
    this.availabilityRefreshMs = opts.availabilityRefreshMs ?? 10 * 60_000;
  }

  async start() {
    await this.adapters.refresh();
    this.pipeline.recoverAfterRestart();
    for (const p of this.db.listProjects()) await G.pruneWorktrees(p.path);
    this.scheduler.start();
    this.availTimer = setInterval(() => { void this.adapters.refresh().then(() => this.broadcastProviders()); }, this.availabilityRefreshMs);
    this.availTimer.unref();
    this.broadcastProviders();
  }

  async shutdown() {
    this.scheduler.stop();
    if (this.availTimer) clearInterval(this.availTimer);
    this.keepAwake.set(false);
    this.pipeline.shuttingDown = true;
    // Abort running agents so their process groups don't outlive us.
    await Promise.all(this.db.listRuns().filter((r) => r.status === 'running' || r.status === 'paused')
      .flatMap((r) => this.db.listTasks(r.id).filter((t) => this.pipeline.isActive(t.id)).map((t) => this.pipeline.stopTask(t.id).catch(() => {}))));
    if (this.providersTimer) clearTimeout(this.providersTimer);
    this.closed = true;
    this.db.close();
  }

  private updateKeepAwake() {
    const busy = this.pipeline.activeCount() > 0 || this.db.listRuns().some((r) => r.status === 'planning');
    this.keepAwake.set(this.config.keepAwake && busy);
  }

  providerStatuses(): ProviderStatus[] {
    return REAL_PROVIDERS.map((id) => {
      const pc = this.config.providers[id];
      const av = this.adapters.availability(id);
      const u = this.limits.usage(id);
      return {
        id, enabled: pc.enabled, installed: av.installed, version: av.version, bin: this.adapters.binFor(id),
        running: this.pipeline.agentsRunning(id), maxConcurrent: pc.maxConcurrent,
        limitedUntil: this.limits.limitedUntil(id), limitMessage: this.limits.limitedUntil(id) ? this.limits.message(id) : null,
        usage5h: u.usage5h, usage7d: u.usage7d, budgetPer5h: pc.budgetPer5h,
      };
    });
  }

  private closed = false;

  broadcastProviders() {
    if (this.closed) return;
    this.bus.providers(this.providerStatuses());
  }

  private broadcastProvidersSoon() {
    if (this.providersTimer) return;
    this.providersTimer = setTimeout(() => { this.providersTimer = null; this.broadcastProviders(); }, 250);
    this.providersTimer.unref();
  }

  /** Validate + deep-merge a settings patch; arrays replace wholesale. */
  updateSettings(patch: unknown): Config {
    const err = validateSettings(patch);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    this.config = deepMerge(this.config, patch);
    if (this.persist) saveConfig(this.config);
    fs.mkdirSync(this.config.worktreeDir, { recursive: true });
    this.broadcastProviders();
    this.scheduler.kick();
    return this.config;
  }
}
