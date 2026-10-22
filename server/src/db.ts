import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent, AgentRole, ModelRef, Project, ReviewResult, Run, StackInfo, StoredEvent, Task, TaskType,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '{}',
  test_command TEXT, setup_command TEXT, link_node_modules INTEGER NOT NULL DEFAULT 1, last_opened INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, goal TEXT NOT NULL,
  status TEXT NOT NULL, base_branch TEXT, base_commit TEXT, lead TEXT NOT NULL, plan_summary TEXT, error TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER, pseudo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, key TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, type TEXT NOT NULL, size TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
  provider TEXT, model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, branch TEXT, worktree TEXT, session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, fix_rounds INTEGER NOT NULL DEFAULT 0, test_status TEXT, test_output TEXT,
  review TEXT, summary TEXT, error TEXT, handoffs INTEGER NOT NULL DEFAULT 0, started_at INTEGER, finished_at INTEGER,
  feedback TEXT, reject_reason TEXT, base_commit TEXT, UNIQUE(run_id, key)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT, provider TEXT, ts INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL,
  task_type TEXT, role TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_provider_ts ON usage(provider, ts);
CREATE TABLE IF NOT EXISTS outcomes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, task_type TEXT NOT NULL,
  first_try_pass INTEGER NOT NULL, critical_issues INTEGER NOT NULL, approved INTEGER, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limits(provider TEXT PRIMARY KEY, limited_until INTEGER NOT NULL, message TEXT);
`;

const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const pj = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

type Row = Record<string, any>;

function toProject(r: Row): Project {
  return {
    id: r.id, path: r.path, name: r.name, stack: pj<StackInfo>(r.stack, { kinds: [], suggestedTest: null, suggestedSetup: null }),
    testCommand: r.test_command, setupCommand: r.setup_command, linkNodeModules: !!r.link_node_modules, lastOpened: r.last_opened,
  };
}

function toRun(r: Row): Run {
  return {
    id: r.id, projectId: r.project_id, goal: r.goal, status: r.status, baseBranch: r.base_branch, baseCommit: r.base_commit,
    lead: pj<ModelRef>(r.lead, { provider: 'claude', model: '' }), planSummary: r.plan_summary, error: r.error,
    createdAt: r.created_at, finishedAt: r.finished_at, pseudo: !!r.pseudo,
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id, runId: r.run_id, key: r.key, title: r.title, description: r.description, type: r.type, size: r.size,
    dependsOn: pj<string[]>(r.depends_on, []), provider: r.provider, model: r.model ?? '', status: r.status,
    branch: r.branch, worktree: r.worktree, sessionId: r.session_id, attempts: r.attempts, fixRounds: r.fix_rounds,
    testStatus: r.test_status, testOutput: r.test_output, review: pj<ReviewResult | null>(r.review, null),
    summary: r.summary, error: r.error, handoffs: r.handoffs, startedAt: r.started_at, finishedAt: r.finished_at,
    feedback: r.feedback, rejectReason: r.reject_reason, baseCommit: r.base_commit,
  };
}

function toEvent(r: Row): StoredEvent {
  const e: StoredEvent = { id: r.id, runId: r.run_id, taskId: r.task_id, provider: r.provider, ts: r.ts, kind: r.kind };
  if (r.text != null) e.text = r.text;
  if (r.data != null) e.data = pj(r.data, undefined);
  return e;
}

const TASK_COLS: Record<string, string> = {
  key: 'key', title: 'title', description: 'description', type: 'type', size: 'size', dependsOn: 'depends_on',
  provider: 'provider', model: 'model', status: 'status', branch: 'branch', worktree: 'worktree', sessionId: 'session_id',
  attempts: 'attempts', fixRounds: 'fix_rounds', testStatus: 'test_status', testOutput: 'test_output', review: 'review',
  summary: 'summary', error: 'error', handoffs: 'handoffs', startedAt: 'started_at', finishedAt: 'finished_at',
  feedback: 'feedback', rejectReason: 'reject_reason', baseCommit: 'base_commit',
};
const TASK_JSON = new Set(['dependsOn', 'review']);

const RUN_COLS: Record<string, string> = {
  goal: 'goal', status: 'status', baseBranch: 'base_branch', baseCommit: 'base_commit', lead: 'lead',
  planSummary: 'plan_summary', error: 'error', finishedAt: 'finished_at',
};
const RUN_JSON = new Set(['lead']);

const PROJECT_COLS: Record<string, string> = {
  name: 'name', stack: 'stack', testCommand: 'test_command', setupCommand: 'setup_command',
  linkNodeModules: 'link_node_modules', lastOpened: 'last_opened',
};

function buildUpdate(cols: Record<string, string>, jsonKeys: Set<string>, patch: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(jsonKeys.has(k) ? j(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  return { sets, vals };
}

export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number }

export class Db {
  readonly sql: Database.Database;

  constructor(file: string) {
    this.sql = new Database(file);
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('foreign_keys = ON');
    this.sql.pragma('busy_timeout = 5000');
    this.sql.exec(SCHEMA);
  }

  close() { this.sql.close(); }

  // ---- projects
  upsertProject(p: Omit<Project, 'id' | 'lastOpened'>): Project {
    const existing = this.sql.prepare('SELECT * FROM projects WHERE path = ?').get(p.path) as Row | undefined;
    const now = Date.now();
    if (existing) {
      this.sql.prepare('UPDATE projects SET last_opened = ?, stack = ? WHERE id = ?').run(now, j(p.stack), existing.id);
      return this.getProject(existing.id)!;
    }
    const id = randomUUID().slice(0, 8);
    this.sql.prepare(`INSERT INTO projects(id, path, name, stack, test_command, setup_command, link_node_modules, last_opened)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, p.path, p.name, j(p.stack), p.testCommand, p.setupCommand, p.linkNodeModules ? 1 : 0, now);
    return this.getProject(id)!;
  }
  getProject(id: string): Project | null {
    const r = this.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }
  listProjects(): Project[] {
    return (this.sql.prepare('SELECT * FROM projects ORDER BY last_opened DESC').all() as Row[]).map(toProject);
  }
  updateProject(id: string, patch: Partial<Project>): Project | null {
    const { sets, vals } = buildUpdate(PROJECT_COLS, new Set(['stack']), patch as Record<string, unknown>);
    if (sets.length) this.sql.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getProject(id);
  }
  deleteProject(id: string) {
    const runs = this.listRuns(id);
    for (const r of runs) this.deleteRun(r.id);
    this.sql.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ---- runs
  createRun(r: Omit<Run, 'id' | 'createdAt' | 'finishedAt' | 'planSummary' | 'error'> & { id?: string }): Run {
    const id = r.id ?? randomUUID().slice(0, 8);
    this.sql.prepare(`INSERT INTO runs(id, project_id, goal, status, base_branch, base_commit, lead, created_at, pseudo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, r.projectId, r.goal, r.status, r.baseBranch, r.baseCommit, j(r.lead), Date.now(), r.pseudo ? 1 : 0);
    return this.getRun(id)!;
  }
  getRun(id: string): Run | null {
    const r = this.sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }
  listRuns(projectId?: string, includePseudo = false): Run[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (projectId) { where.push('project_id = ?'); vals.push(projectId); }
    if (!includePseudo) where.push('pseudo = 0');
    const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.sql.prepare(sql).all(...vals) as Row[]).map(toRun);
  }
  updateRun(id: string, patch: Partial<Run>): Run | null {
    const { sets, vals } = buildUpdate(RUN_COLS, RUN_JSON, patch as Record<string, unknown>);
    if (sets.length) this.sql.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getRun(id);
  }
  deleteRun(id: string) {
    this.sql.prepare('DELETE FROM events WHERE run_id = ?').run(id);
    this.sql.prepare('DELETE FROM tasks WHERE run_id = ?').run(id);
    this.sql.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  // ---- tasks
  insertTask(t: Pick<Task, 'runId' | 'key' | 'title' | 'description' | 'type' | 'size' | 'dependsOn' | 'provider' | 'model'>): Task {
    const id = randomUUID().slice(0, 8);
    this.sql.prepare(`INSERT INTO tasks(id, run_id, key, title, description, type, size, depends_on, provider, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, t.runId, t.key, t.title, t.description, t.type, t.size, j(t.dependsOn), t.provider, t.model);
    return this.getTask(id)!;
  }
  getTask(id: string): Task | null {
    const r = this.sql.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }
  listTasks(runId: string): Task[] {
    return (this.sql.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid').all(runId) as Row[]).map(toTask);
  }
  tasksByStatus(statuses: string[]): Task[] {
    const q = statuses.map(() => '?').join(',');
    return (this.sql.prepare(`SELECT * FROM tasks WHERE status IN (${q})`).all(...statuses) as Row[]).map(toTask);
  }
  updateTask(id: string, patch: Partial<Task>): Task | null {
    const { sets, vals } = buildUpdate(TASK_COLS, TASK_JSON, patch as Record<string, unknown>);
    if (sets.length) this.sql.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getTask(id);
  }

  // ---- events
  insertEvent(runId: string, taskId: string | null, provider: string | null, e: AgentEvent): StoredEvent {
    const ts = Date.now();
    const info = this.sql.prepare('INSERT INTO events(run_id, task_id, provider, ts, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, taskId, provider, ts, e.kind, e.text ?? null, j(e.data));
    const out: StoredEvent = { id: Number(info.lastInsertRowid), runId, taskId, provider, ts, kind: e.kind };
    if (e.text !== undefined) out.text = e.text;
    if (e.data !== undefined) out.data = e.data;
    return out;
  }
  listEvents(runId: string, opts: { after?: number; taskId?: string; limit?: number } = {}): StoredEvent[] {
    const vals: unknown[] = [runId, opts.after ?? 0];
    let sql = 'SELECT * FROM events WHERE run_id = ? AND id > ?';
    if (opts.taskId) { sql += ' AND task_id = ?'; vals.push(opts.taskId); }
    sql += ' ORDER BY id LIMIT ?';
    vals.push(Math.min(Math.max(opts.limit ?? 1000, 1), 5000));
    return (this.sql.prepare(sql).all(...vals) as Row[]).map(toEvent);
  }
  lastEventText(taskId: string, kinds: string[]): string | null {
    const q = kinds.map(() => '?').join(',');
    const r = this.sql.prepare(`SELECT text FROM events WHERE task_id = ? AND kind IN (${q}) AND text IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(taskId, ...kinds) as Row | undefined;
    return r?.text ?? null;
  }

  // ---- usage
  insertUsage(u: { provider: string; model: string; taskType: TaskType | null; role: AgentRole; inputTokens: number; outputTokens: number; durationMs: number }) {
    this.sql.prepare('INSERT INTO usage(provider, model, ts, task_type, role, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.provider, u.model, Date.now(), u.taskType, u.role, u.inputTokens, u.outputTokens, u.durationMs);
  }
  usageSince(provider: string, since: number): UsageTotals {
    const r = this.sql.prepare('SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage WHERE provider = ? AND ts >= ?')
      .get(provider, since) as Row;
    return { calls: r.c, inputTokens: r.i, outputTokens: r.o };
  }

  // ---- outcomes
  insertOutcome(o: { taskId: string; provider: string; model: string; taskType: string; firstTryPass: boolean; criticalIssues: number; durationMs: number }) {
    this.sql.prepare('DELETE FROM outcomes WHERE task_id = ? AND approved IS NULL').run(o.taskId);
    this.sql.prepare('INSERT INTO outcomes(task_id, provider, model, task_type, first_try_pass, critical_issues, approved, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(o.taskId, o.provider, o.model, o.taskType, o.firstTryPass ? 1 : 0, o.criticalIssues, o.durationMs, Date.now());
  }
  setOutcomeApproved(taskId: string, approved: boolean) {
    this.sql.prepare('UPDATE outcomes SET approved = ? WHERE id = (SELECT id FROM outcomes WHERE task_id = ? ORDER BY id DESC LIMIT 1)')
      .run(approved ? 1 : 0, taskId);
  }
  outcomeStats(): Array<{ provider: string; model: string; taskType: string; n: number; passRate: number; avgCritical: number; approvalRate: number | null; avgDurationMs: number }> {
    return (this.sql.prepare(`SELECT provider, model, task_type, COUNT(*) n, AVG(first_try_pass) pr, AVG(critical_issues) ac,
        AVG(approved) ar, AVG(duration_ms) ad FROM outcomes GROUP BY provider, model, task_type ORDER BY task_type, provider, model`).all() as Row[])
      .map((r) => ({ provider: r.provider, model: r.model, taskType: r.task_type, n: r.n, passRate: r.pr, avgCritical: r.ac, approvalRate: r.ar, avgDurationMs: r.ad }));
  }
  outcomesFor(provider: string, model: string, taskType: string): { n: number; passRate: number; avgCritical: number } {
    const r = this.sql.prepare('SELECT COUNT(*) n, COALESCE(AVG(first_try_pass),0) pr, COALESCE(AVG(critical_issues),0) ac FROM outcomes WHERE provider = ? AND model = ? AND task_type = ?')
      .get(provider, model, taskType) as Row;
    return { n: r.n, passRate: r.pr, avgCritical: r.ac };
  }

  // ---- limits
  getLimit(provider: string): { until: number; message: string | null } | null {
    const r = this.sql.prepare('SELECT * FROM limits WHERE provider = ?').get(provider) as Row | undefined;
    return r ? { until: r.limited_until, message: r.message } : null;
  }
  setLimit(provider: string, until: number, message: string | null) {
    this.sql.prepare('INSERT INTO limits(provider, limited_until, message) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET limited_until = excluded.limited_until, message = excluded.message')
      .run(provider, until, message);
  }
  clearLimit(provider: string) {
    this.sql.prepare('DELETE FROM limits WHERE provider = ?').run(provider);
  }
}
