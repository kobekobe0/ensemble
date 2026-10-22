import type { Bus } from './bus.js';
import type { Db } from './db.js';
import type { Config, RealProviderId } from './types.js';

// ---- detection (§11) ----------------------------------------------------------------------

const LIMIT_PATTERNS = [
  /usage limit/i, /rate[ _-]?limit/i, /limit reached/i, /limit exceeded/i, /quota/i, /resource_exhausted/i,
  /too many requests/i, /\b429\b/, /try again (in|at|later)/i, /resets? (at|in)\b/i,
];

export interface LimitHit { message: string; resetAt: number | null }

/**
 * Returns a hit if `text` looks like a usage/rate-limit message. Only call this on error/stderr/result
 * fields, never on the agent's own text output (it may legitimately talk about "quota").
 */
export function detectLimit(text: string | null | undefined, now = Date.now()): LimitHit | null {
  if (!text) return null;
  const s = String(text);
  if (!LIMIT_PATTERNS.some((re) => re.test(s))) return null;
  return { message: s.trim().slice(0, 500), resetAt: parseResetTime(s, now) };
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

function unitOf(u: string): number | null {
  const x = u.toLowerCase();
  if (x.startsWith('d')) return UNIT_MS.d;
  if (x.startsWith('h')) return UNIT_MS.h;
  if (x.startsWith('mi') || x === 'm') return UNIT_MS.m;
  if (x.startsWith('s')) return UNIT_MS.s;
  return null;
}

/** Parse a reset time out of a limit message. Returns epoch ms or null. */
export function parseResetTime(text: string, now = Date.now()): number | null {
  // 1a. ISO timestamps
  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0].replace(' ', 'T'));
    if (!Number.isNaN(t)) return t;
  }
  // 1b. Absolute clock time: "resets at 3:00 PM", "resets 3pm", "at 15:00"
  const clock = text.match(/(?:resets?(?:\s+at)?|\bat)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d.:])/i);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let h = Number(clock[1]);
    const min = clock[2] !== undefined ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase().replace(/\./g, '');
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 24 && min < 60) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  // 2. Relative duration: "in 2 hours", "in 45 minutes", "in 1h 30m", "after 30s"
  const rel = text.match(/\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i);
  if (rel) {
    let total = 0;
    for (const part of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const unit = unitOf(part[2]);
      if (unit) total += Number(part[1]) * unit;
    }
    if (total > 0) return now + total;
  }
  // 3. Epoch / retry fields in JSON
  const field = text.match(/"?(resetsAt|resets_at|reset_at|resetAt|retry_after|retryAfter|retry-after)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i);
  if (field) {
    const v = Number(field[2]);
    if (/retry/i.test(field[1])) return now + v * 1000;
    return v > 1e12 ? v : v * 1000;
  }
  return null;
}

// ---- state --------------------------------------------------------------------------------

export class Limits {
  constructor(private db: Db, private bus: Bus, private cfg: () => Config) {}

  /** Epoch ms until which the provider is limited, or null. Expired limits are cleared lazily. */
  limitedUntil(provider: RealProviderId, now = Date.now()): number | null {
    const l = this.db.getLimit(provider);
    if (!l) return null;
    if (l.until <= now) return null;
    return l.until;
  }

  isLimited(provider: RealProviderId, now = Date.now()): boolean {
    return this.limitedUntil(provider, now) !== null;
  }

  message(provider: RealProviderId): string | null {
    return this.db.getLimit(provider)?.message ?? null;
  }

  /** Record a limit hit. Returns the effective reset time. */
  record(provider: RealProviderId, hit: { resetAt: number | null; message: string }, runId?: string, taskId?: string): number {
    const cooldown = this.cfg().providers[provider].limitCooldownMinutes * 60_000;
    const until = hit.resetAt && hit.resetAt > Date.now() ? hit.resetAt : Date.now() + cooldown;
    this.db.setLimit(provider, until, hit.message);
    if (runId) {
      this.bus.emit(runId, taskId ?? null, provider, {
        kind: 'limit', text: `${provider} hit its usage limit (resets ~${fmtTime(until)})`, data: { until, message: hit.message },
      });
    }
    this.bus.notify(`${cap(provider)} hit its usage limit`, `Resets ~${fmtTime(until)}`, runId ? `/runs/${runId}` : undefined);
    return until;
  }

  setManual(provider: RealProviderId, until: number) {
    this.db.setLimit(provider, until, 'Marked as limited manually');
  }

  clear(provider: RealProviderId) {
    this.db.clearLimit(provider);
  }

  usage(provider: RealProviderId, now = Date.now()) {
    return {
      usage5h: this.db.usageSince(provider, now - 5 * 3_600_000),
      usage7d: this.db.usageSince(provider, now - 7 * 86_400_000),
    };
  }

  /** calls in the last 5h / budget — used for the usage bar and the router's headroom tiebreak. */
  headroomRatio(provider: RealProviderId): number {
    const budget = Math.max(1, this.cfg().providers[provider].budgetPer5h);
    return this.db.usageSince(provider, Date.now() - 5 * 3_600_000).calls / budget;
  }
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
