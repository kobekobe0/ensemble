// Model routing + learning (§10).
import type { AdapterRegistry } from './adapters/index.js';
import type { Db } from './db.js';
import type { Limits } from './limits.js';
import type { Config, ModelRef, RealProviderId, TaskSize, TaskType } from './types.js';

export class NoProviderError extends Error {}

export interface RouteOptions {
  exclude?: RealProviderId[];
  /** exclude a specific provider+model pair (used for self-review fallback) */
  excludeRef?: ModelRef;
}

export interface RouteResult extends ModelRef {
  /** true when every candidate is limited and this one will follow the limit policy */
  limited: boolean;
}

const isFast = (model: string) => /haiku|flash|mini/i.test(model);

export class Router {
  constructor(private cfg: () => Config, private db: Db, private adapters: AdapterRegistry, private limits: Limits) {}

  route(type: TaskType, size: TaskSize, opts: RouteOptions = {}): RouteResult {
    const cfg = this.cfg();
    const table = cfg.routing[type] ?? cfg.routing.implement;
    const allowed = table.filter((c) =>
      this.adapters.usable(c.provider)
      && !opts.exclude?.includes(c.provider)
      && !(opts.excludeRef && opts.excludeRef.provider === c.provider && opts.excludeRef.model === c.model));
    const available = allowed.filter((c) => !this.limits.isLimited(c.provider));

    if (!available.length) {
      if (allowed.length) return { ...allowed[0], limited: true };
      throw new NoProviderError(`No provider available for ${type}`);
    }

    let ordered = available.map((c, i) => ({ c, i, score: 0, hasData: false }));
    if (cfg.learnRouting && ordered.length >= 2) {
      const stats = ordered.map((o) => this.db.outcomesFor(o.c.provider, o.c.model, type));
      if (stats[0].n >= 5 && stats[1].n >= 5) {
        ordered.forEach((o, idx) => {
          const s = stats[idx];
          o.hasData = s.n >= 5;
          o.score = o.hasData ? s.passRate - 0.15 * s.avgCritical : -Infinity;
        });
        ordered = ordered.sort((a, b) => b.score - a.score || a.i - b.i);
      }
    }

    // Headroom tiebreak: scores within 0.1 (or no learning data) → prefer the lower 5h usage ratio.
    if (ordered.length >= 2) {
      const [a, b] = ordered;
      const close = !a.hasData || !b.hasData || Math.abs(a.score - b.score) <= 0.1;
      if (close && a.c.provider !== b.c.provider) {
        const ra = this.limits.headroomRatio(a.c.provider);
        const rb = this.limits.headroomRatio(b.c.provider);
        if (rb < ra) [ordered[0], ordered[1]] = [b, a];
      }
    }

    let pick = ordered[0].c;
    if (size === 'large' && isFast(pick.model)) {
      const next = ordered.find((o) => !isFast(o.c.model));
      if (next) pick = next.c;
    }
    return { provider: pick.provider, model: pick.model, limited: false };
  }

  stats() {
    return this.db.outcomeStats();
  }
}
