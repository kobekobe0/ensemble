// Concurrency caps + dependency resolution (§8.3).
import type { AdapterRegistry } from './adapters/index.js';
import type { Db } from './db.js';
import type { Limits } from './limits.js';
import type { Pipeline } from './pipeline.js';
import type { Config, Task } from './types.js';
import { SETTLED_TASK } from './types.js';

const BLOCKING = new Set(['failed', 'stopped', 'rejected']);

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private queued = false;
  private ticking = false;

  constructor(
    private cfg: () => Config,
    private db: Db,
    private pipeline: Pipeline,
    private limits: Limits,
    private adapters: AdapterRegistry,
    private tickMs = 2000,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    this.kick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Coalesced tick on the next turn of the event loop. */
  kick() {
    if (this.queued) return;
    this.queued = true;
    setImmediate(() => { this.queued = false; this.tick(); });
  }

  tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { this.doTick(); } catch (e) {
      console.error('[scheduler]', e);
    } finally { this.ticking = false; }
  }

  private doTick() {
    const cfg = this.cfg();
    const now = Date.now();
    const grace = this.pipeline.opts.limitGraceMs;
    for (const run of this.db.listRuns()) {
      if (run.status !== 'running') continue;
      const tasks = this.db.listTasks(run.id);
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      for (let t of tasks) {
        if (t.status !== 'pending' && t.status !== 'waiting_limit') continue;
        if (this.pipeline.isActive(t.id)) continue;

        // Dependencies
        let ready = true;
        let blocked: string | null = null;
        for (const k of t.dependsOn) {
          const dep = byKey.get(k);
          if (!dep) continue;
          if (BLOCKING.has(dep.status)) { blocked = k; break; }
          if (!SETTLED_TASK.includes(dep.status)) ready = false;
        }
        if (blocked) { this.pipeline.failDependent(t, blocked); continue; }
        if (!ready) continue;

        if (this.pipeline.activeCount() >= cfg.maxParallel) return;

        if (!t.provider) {
          const assigned = this.pipeline.assign(t);
          if (!assigned) continue;
          t = assigned;
        }
        const provider = t.provider!;

        if (t.status === 'waiting_limit') {
          // Resume once the limit (plus grace) has passed (§11 wait policy).
          if (this.limits.isLimited(provider, now - grace)) continue;
          this.limits.clear(provider);
          if (!this.capOk(t)) continue;
          this.pipeline.startTask(t, 'continue');
          continue;
        }

        if (this.limits.isLimited(provider) || !this.adapters.usable(provider)) {
          if (cfg.onLimit === 'handoff' || !this.adapters.usable(provider)) {
            if (!this.pipeline.rerouteLimited(t)) continue;
            t = this.db.getTask(t.id)!;
          } else continue;
        }
        if (!this.capOk(t)) continue;
        this.pipeline.startTask(t, 'fresh');
      }
    }
  }

  private capOk(t: Task): boolean {
    const p = t.provider!;
    return this.pipeline.activeForProvider(p) < this.cfg().providers[p].maxConcurrent;
  }
}
