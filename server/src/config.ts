import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, ModelRef, ProviderConfig, TaskType } from './types.js';
import { TASK_TYPES } from './types.js';

export const VERSION = '0.1.0';

export function isDemo(): boolean {
  return process.env.ENSEMBLE_DEMO === '1';
}

export function dataDir(): string {
  if (process.env.ENSEMBLE_HOME) return expandHome(process.env.ENSEMBLE_HOME);
  return path.join(os.homedir(), isDemo() ? '.ensemble-demo' : '.ensemble');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultRoots(): string[] {
  const home = os.homedir();
  const candidates = ['Projects', 'Developer', 'Code', 'code', 'dev', 'Documents/GitHub', 'repos'].map((d) => path.join(home, d));
  const existing = candidates.filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  // On case-insensitive filesystems ~/Code and ~/code resolve to the same folder; dedupe by realpath.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of existing) {
    let real = d;
    try { real = fs.realpathSync(d); } catch { /* keep */ }
    const key = real.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(d); }
  }
  return out.length ? out : [home];
}

const provider = (bin: string): ProviderConfig => ({
  enabled: true, bin, maxConcurrent: 2, extraArgs: [], limitCooldownMinutes: 60, budgetPer5h: 40,
});

const m = (provider: ModelRef['provider'], model = ''): ModelRef => ({ provider, model });

export function defaultRouting(): Record<TaskType, ModelRef[]> {
  const planLike = [m('claude', 'opus'), m('codex'), m('gemini')];
  return {
    plan: planLike,
    architecture: planLike.map((x) => ({ ...x })),
    implement: [m('codex'), m('claude', 'sonnet'), m('gemini')],
    refactor: [m('claude', 'sonnet'), m('codex'), m('gemini')],
    ui: [m('claude', 'sonnet'), m('codex'), m('gemini')],
    tests: [m('codex'), m('claude', 'sonnet'), m('gemini')],
    'small-fix': [m('claude', 'haiku'), m('gemini'), m('codex')],
    analysis: [m('gemini'), m('claude', 'sonnet'), m('codex')],
    docs: [m('gemini'), m('claude', 'haiku'), m('codex')],
    review: [m('claude', 'sonnet'), m('codex'), m('gemini')],
  };
}

export function defaultConfig(): Config {
  return {
    host: '127.0.0.1',
    port: 4317,
    allowedRoots: defaultRoots(),
    worktreeDir: path.join(dataDir(), 'worktrees'),
    maxParallel: 4,
    providers: { claude: provider('claude'), codex: provider('codex'), gemini: provider('gemini') },
    lead: m('claude', 'opus'),
    routing: defaultRouting(),
    learnRouting: true,
    onLimit: 'handoff',
    maxTestRetries: 2,
    maxReviewFixRounds: 1,
    agentTimeoutMinutes: 45,
    testTimeoutMinutes: 15,
    keepAwake: true,
    reviewPlanBeforeStart: false,
    ntfyTopic: null,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `over` onto `base`. Arrays and primitives replace wholesale. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

export function loadConfig(): Config {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  let user: unknown = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      console.error(`[config] could not parse ${file}: ${(e as Error).message}; using defaults`);
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2));
  }
  const cfg = deepMerge(defaultConfig(), user);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.ENSEMBLE_HOST) cfg.host = process.env.ENSEMBLE_HOST;
  cfg.allowedRoots = cfg.allowedRoots.map(expandHome);
  cfg.worktreeDir = expandHome(cfg.worktreeDir);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ---- validation for PUT /api/settings -------------------------------------------------

type Check = (v: unknown, at: string) => string | null;
const num: Check = (v, at) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : `${at} must be a non-negative number`);
const int1: Check = (v, at) => (Number.isInteger(v) && (v as number) >= 1 ? null : `${at} must be an integer ≥ 1`);
const bool: Check = (v, at) => (typeof v === 'boolean' ? null : `${at} must be a boolean`);
const str: Check = (v, at) => (typeof v === 'string' ? null : `${at} must be a string`);
const strArr: Check = (v, at) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : `${at} must be an array of strings`);
const providerId: Check = (v, at) => (v === 'claude' || v === 'codex' || v === 'gemini' ? null : `${at} must be claude|codex|gemini`);
const modelRef: Check = (v, at) => {
  if (!isPlainObject(v)) return `${at} must be an object`;
  const extra = Object.keys(v).filter((k) => k !== 'provider' && k !== 'model');
  if (extra.length) return `${at}: unknown key ${extra[0]}`;
  return providerId(v.provider, `${at}.provider`) ?? str(v.model, `${at}.model`);
};

const providerShape: Record<keyof ProviderConfig, Check> = {
  enabled: bool, bin: str, maxConcurrent: int1, extraArgs: strArr, limitCooldownMinutes: num, budgetPer5h: int1,
};

const shape: Record<keyof Config, Check> = {
  host: str,
  port: (v, at) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? null : `${at} must be a port number`),
  allowedRoots: strArr,
  worktreeDir: str,
  maxParallel: int1,
  providers: (v, at) => {
    if (!isPlainObject(v)) return `${at} must be an object`;
    for (const [pid, pc] of Object.entries(v)) {
      if (providerId(pid, at)) return `${at}: unknown provider ${pid}`;
      if (!isPlainObject(pc)) return `${at}.${pid} must be an object`;
      for (const [k, val] of Object.entries(pc)) {
        const c = providerShape[k as keyof ProviderConfig];
        if (!c) return `${at}.${pid}: unknown key ${k}`;
        const err = c(val, `${at}.${pid}.${k}`);
        if (err) return err;
      }
    }
    return null;
  },
  lead: modelRef,
  routing: (v, at) => {
    if (!isPlainObject(v)) return `${at} must be an object`;
    for (const [t, list] of Object.entries(v)) {
      if (!TASK_TYPES.includes(t as TaskType)) return `${at}: unknown task type ${t}`;
      if (!Array.isArray(list) || list.length === 0) return `${at}.${t} must be a non-empty array`;
      for (let i = 0; i < list.length; i++) {
        const err = modelRef(list[i], `${at}.${t}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  },
  learnRouting: bool,
  onLimit: (v, at) => (v === 'handoff' || v === 'wait' ? null : `${at} must be handoff|wait`),
  maxTestRetries: num,
  maxReviewFixRounds: num,
  agentTimeoutMinutes: num,
  testTimeoutMinutes: num,
  keepAwake: bool,
  reviewPlanBeforeStart: bool,
  ntfyTopic: (v, at) => (v === null || (typeof v === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(v)) ? null : `${at} must be null or a topic name [A-Za-z0-9_-]`),
};

/** Validate a (partial) settings object. Returns an error message or null. Unknown keys are rejected. */
export function validateSettings(input: unknown): string | null {
  if (!isPlainObject(input)) return 'settings must be an object';
  for (const [k, v] of Object.entries(input)) {
    const check = shape[k as keyof Config];
    if (!check) return `unknown key ${k}`;
    const err = check(v, k);
    if (err) return err;
  }
  return null;
}
