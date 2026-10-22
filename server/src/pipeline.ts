// Run and task state machines (§8).
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterRegistry, AgentResult } from './adapters/index.js';
import { runProcess } from './adapters/base.js';
import type { Bus } from './bus.js';
import { truncate } from './bus.js';
import type { Db } from './db.js';
import * as G from './git.js';
import type { Limits } from './limits.js';
import { agentsMdPrompt, cleanMarkdownReply, CONTINUE_PROMPT, fixPrompt, handoffPrompt, parsePlan, parseReview, PLAN_RETRY_PROMPT, planningPrompt, reviewPrompt, topoSort, workPrompt, type Plan } from './prompts.js';
import { detectStack, fileTree, nodeModulesDirs, readAgentsMd } from './projects.js';
import { NoProviderError, type Router } from './router.js';
import type {
  AgentEvent, AgentRole, Config, ModelRef, Project, RealProviderId, ReviewResult, Run, Task, TaskStatus,
} from './types.js';
import { ACTIVE_TASK, SETTLED_TASK, TERMINAL_TASK } from './types.js';

export class UserError extends Error {
  constructor(message: string, readonly status = 400, readonly extra?: Record<string, unknown>) { super(message); }
}

type StartMode = 'fresh' | 'continue' | 'handoff';

interface Active { ctrl: AbortController; provider: RealProviderId | null }

type StepOutcome =
  | { kind: 'ok'; result: AgentResult }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }
  | { kind: 'limited'; result: AgentResult };

class Halt extends Error {}  // unwinds a task job after its status has already been set

const SUMMARY_MAX = 4 * 1024;
const TEST_TAIL = 8 * 1024;
const DIFF_DISPLAY = 200 * 1024;
const DIFF_REVIEW = 120 * 1024;

export interface PipelineOptions {
  /** extra delay after a limit's reset time before resuming (§11: +1 min) */
  limitGraceMs: number;
}

export class Pipeline {
  private active = new Map<string, Active>();
  private agentRunning = new Map<RealProviderId, number>();
  /** called whenever something changed that may let the scheduler start more work */
  kick: () => void = () => {};
  onProvidersChanged: () => void = () => {};

  constructor(
    private cfg: () => Config,
    private db: Db,
    private bus: Bus,
    private adapters: AdapterRegistry,
    private limits: Limits,
    private router: Router,
    readonly opts: PipelineOptions,
  ) {}

  // ---- accessors used by the scheduler / API --------------------------------------------------

  isActive(taskId: string) { return this.active.has(taskId); }
  activeCount() { return this.active.size; }
  activeForProvider(p: RealProviderId) {
    let n = 0;
    for (const a of this.active.values()) if (a.provider === p) n++;
    return n;
  }
  agentsRunning(p: RealProviderId) { return this.agentRunning.get(p) ?? 0; }

  // ---- helpers --------------------------------------------------------------------------------

  private emit(runId: string, taskId: string | null, provider: string | null, e: AgentEvent) {
    return this.bus.emit(runId, taskId, provider, e);
  }

  private setTask(id: string, patch: Partial<Task>): Task {
    const before = this.db.getTask(id);
    const t = this.db.updateTask(id, patch)!;
    if (patch.status && before && before.status !== patch.status) {
      this.emit(t.runId, t.id, t.provider, { kind: 'status', text: `${t.key} → ${patch.status}`, data: { status: patch.status, from: before.status } });
    }
    this.bus.task(t);
    if (patch.status) this.checkRunDone(t.runId);
    return t;
  }

  private setRun(id: string, patch: Partial<Run>): Run {
    const r = this.db.updateRun(id, patch)!;
    this.bus.run(r);
    return r;
  }

  private project(run: Run): Project {
    const p = this.db.getProject(run.projectId);
    if (!p) throw new UserError('project not found', 404);
    return p;
  }

  private worktreeFor(project: Project, run: Run, key: string, suffix = '') {
    return {
      branch: `ensemble/${run.id}/${key}${suffix}`,
      dir: path.join(this.cfg().worktreeDir, `${safeName(project.name)}-${project.id}`, run.id, key + suffix),
    };
  }

  private timeoutMs() { return this.cfg().agentTimeoutMinutes * 60_000; }

  /** Run one adapter invocation with event streaming + usage recording. */
  private async invoke(i: {
    run: Run; task: Task | null; ref: ModelRef; role: AgentRole; cwd: string; prompt: string; readOnly: boolean;
    resumeSessionId?: string; signal: AbortSignal;
  }): Promise<AgentResult> {
    const { run, task, ref } = i;
    const adapter = this.adapters.get(ref.provider);
    this.agentRunning.set(ref.provider, this.agentsRunning(ref.provider) + 1);
    this.onProvidersChanged();
    this.emit(run.id, task?.id ?? null, ref.provider, {
      kind: 'status', text: `${ref.provider}/${ref.model || 'default'} · ${i.role}${i.resumeSessionId ? ' (resumed session)' : ''}`,
      data: { role: i.role, provider: ref.provider, model: ref.model },
    });
    try {
      const res = await adapter.run({
        cwd: i.cwd, prompt: i.prompt, model: ref.model, readOnly: i.readOnly, resumeSessionId: i.resumeSessionId,
        timeoutMs: this.timeoutMs(), signal: i.signal, role: i.role, taskKey: task?.key,
        onEvent: (e) => this.emit(run.id, task?.id ?? null, ref.provider, e),
      });
      this.db.insertUsage({
        provider: ref.provider, model: ref.model, taskType: task?.type ?? (i.role === 'plan' ? 'plan' : null), role: i.role,
        inputTokens: res.inputTokens, outputTokens: res.outputTokens, durationMs: res.durationMs,
      });
      if (res.error && !res.limited && !i.signal.aborted) this.emit(run.id, task?.id ?? null, ref.provider, { kind: 'error', text: res.error });
      return res;
    } finally {
      this.agentRunning.set(ref.provider, Math.max(0, this.agentsRunning(ref.provider) - 1));
      this.onProvidersChanged();
    }
  }

  // ---- runs ---------------------------------------------------------------------------------

  async createRun(input: { projectId: string; goal: string; lead?: ModelRef; reviewPlan?: boolean }): Promise<Run> {
    const project = this.db.getProject(input.projectId);
    if (!project) throw new UserError('project not found', 404);
    const goal = String(input.goal ?? '').trim();
    if (!goal) throw new UserError('goal is required');
    if (!(await G.toplevel(project.path))) throw new UserError(`${project.path} is not a git repository`);
    if (!(await G.hasCommits(project.path))) throw new UserError('the repository has no commits yet — make an initial commit first');
    const baseBranch = await G.currentBranch(project.path);
    if (baseBranch === 'HEAD') throw new UserError('HEAD is detached — check out a branch in the project before starting a run');
    const baseCommit = await G.headCommit(project.path);
    const lead = input.lead ?? this.cfg().lead;
    const run = this.db.createRun({ projectId: project.id, goal, status: 'planning', baseBranch, baseCommit, lead });
    this.bus.run(run);
    if (await G.isDirty(project.path)) {
      this.emit(run.id, null, null, { kind: 'log', text: 'Warning: the project has uncommitted changes. Agents start from the last commit and will not see them.', data: { warning: true } });
    }
    const reviewPlan = input.reviewPlan ?? this.cfg().reviewPlanBeforeStart;
    void this.planRun(run.id, reviewPlan).catch((e) => { try { this.failRun(run.id, (e as Error).message); } catch { /* db closed */ } });
    return run;
  }

  private failRun(runId: string, error: string) {
    this.emit(runId, null, null, { kind: 'error', text: `Planning failed: ${error}` });
    this.setRun(runId, { status: 'failed', error, finishedAt: Date.now() });
    this.bus.notify('Run failed', error, `/runs/${runId}`);
  }

  private planCandidates(lead: ModelRef): ModelRef[] {
    const list = [lead, ...this.cfg().routing.plan];
    const seen = new Set<string>();
    return list.filter((c) => {
      const k = `${c.provider}/${c.model}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return this.adapters.usable(c.provider);
    });
  }

  private async planRun(runId: string, reviewPlan: boolean) {
    let run = this.db.getRun(runId)!;
    const project = this.project(run);
    const ctrl = new AbortController();
    this.planning.set(runId, ctrl);
    try {
      const prompt = planningPrompt({
        goal: run.goal, projectName: project.name, stack: project.stack, testCommand: project.testCommand,
        tree: fileTree(project.path), agentsMd: readAgentsMd(project.path)?.content ?? null,
      });
      let plan: Plan | null = null;
      let lastError = 'no planning provider available (enable and install claude, codex or gemini)';
      for (const ref of this.planCandidates(run.lead)) {
        if (ctrl.signal.aborted) return;
        if (this.limits.isLimited(ref.provider)) { lastError = `${ref.provider} is usage-limited`; continue; }
        this.emit(runId, null, ref.provider, { kind: 'status', text: `Planning with ${ref.provider}/${ref.model || 'default'}` });
        const res = await this.invoke({ run, task: null, ref, role: 'plan', cwd: project.path, prompt, readOnly: true, signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (res.limited) { this.limits.record(ref.provider, res.limited, runId); this.onProvidersChanged(); lastError = res.limited.message; continue; }
        if (!res.ok) { lastError = res.error ?? 'planning agent failed'; continue; }
        try {
          plan = parsePlan(res.finalText);
        } catch (e) {
          this.emit(runId, null, ref.provider, { kind: 'log', text: `Plan could not be parsed (${(e as Error).message}); asking again for valid JSON.` });
          const retry = await this.invoke({
            run, task: null, ref, role: 'plan', cwd: project.path, readOnly: true, signal: ctrl.signal,
            prompt: res.sessionId ? PLAN_RETRY_PROMPT : `${prompt}\n\n${PLAN_RETRY_PROMPT}`,
            resumeSessionId: res.sessionId ?? undefined,
          });
          if (ctrl.signal.aborted) return;
          if (retry.limited) { this.limits.record(ref.provider, retry.limited, runId); lastError = retry.limited.message; continue; }
          try { plan = parsePlan(retry.finalText); } catch (e2) { lastError = `plan JSON invalid: ${(e2 as Error).message}`; }
        }
        if (plan) { run = this.setRun(runId, { lead: ref }); break; }
      }
      if (!plan) { this.failRun(runId, lastError); return; }

      for (const pt of plan.tasks) {
        let ref: ModelRef | null = null;
        if (pt.suggestedProvider && this.adapters.usable(pt.suggestedProvider) && !this.limits.isLimited(pt.suggestedProvider)) {
          const fromTable = this.cfg().routing[pt.type]?.find((c) => c.provider === pt.suggestedProvider);
          ref = { provider: pt.suggestedProvider, model: fromTable?.model ?? '' };
        }
        if (!ref) {
          try { ref = this.router.route(pt.type, pt.size); } catch { ref = null; }
        }
        const t = this.db.insertTask({
          runId, key: pt.key, title: pt.title, description: pt.description, type: pt.type, size: pt.size,
          dependsOn: pt.dependsOn, provider: ref?.provider ?? null, model: ref?.model ?? '',
        });
        this.bus.task(t);
      }
      this.emit(runId, null, run.lead.provider, { kind: 'status', text: `Plan ready: ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`, data: { summary: plan.summary } });
      if (this.db.getRun(runId)!.status !== 'planning') return; // stopped meanwhile
      this.setRun(runId, { planSummary: plan.summary, status: reviewPlan ? 'plan_review' : 'running' });
      if (reviewPlan) this.bus.notify('Plan ready for review', run.goal.slice(0, 120), `/runs/${runId}`);
      this.kick();
    } finally {
      this.planning.delete(runId);
    }
  }

  private planning = new Map<string, AbortController>();

  startRun(runId: string): Run {
    const run = this.db.getRun(runId);
    if (!run) throw new UserError('run not found', 404);
    if (run.status !== 'plan_review') throw new UserError(`run is ${run.status}, not awaiting plan review`);
    const r = this.setRun(runId, { status: 'running' });
    this.kick();
    return r;
  }

  pauseRun(runId: string): Run {
    const run = this.db.getRun(runId);
    if (!run) throw new UserError('run not found', 404);
    if (run.status !== 'running') throw new UserError(`run is ${run.status}`);
    return this.setRun(runId, { status: 'paused' });
  }

  resumeRun(runId: string): Run {
    const run = this.db.getRun(runId);
    if (!run) throw new UserError('run not found', 404);
    if (run.status !== 'paused') throw new UserError(`run is ${run.status}`);
    const r = this.setRun(runId, { status: 'running' });
    this.kick();
    return r;
  }

  async stopRun(runId: string): Promise<Run> {
    const run = this.db.getRun(runId);
    if (!run) throw new UserError('run not found', 404);
    if (['done', 'failed', 'stopped'].includes(run.status)) return run;
    // Mark the run stopped first so finishing tasks don't flip it to "done".
    const r = this.setRun(runId, { status: 'stopped', finishedAt: Date.now() });
    this.planning.get(runId)?.abort();
    const waits: Promise<void>[] = [];
    for (const t of this.db.listTasks(runId)) {
      if (this.active.has(t.id)) waits.push(this.stopTask(t.id));
      else if (t.status === 'pending' || t.status === 'waiting_limit') this.setTask(t.id, { status: 'stopped', finishedAt: Date.now() });
    }
    await Promise.all(waits);
    await this.cleanupRun(runId);
    return this.db.getRun(runId) ?? r;
  }

  async deleteRun(runId: string) {
    const run = this.db.getRun(runId);
    if (!run) throw new UserError('run not found', 404);
    if (['planning', 'plan_review', 'running', 'paused'].includes(run.status)) await this.stopRun(runId);
    await this.cleanupRun(runId, { allBranches: true });
    this.db.deleteRun(runId);
  }

  private checkRunDone(runId: string) {
    const run = this.db.getRun(runId);
    if (!run || run.pseudo || !['running', 'paused'].includes(run.status)) return;
    const tasks = this.db.listTasks(runId);
    if (!tasks.length || !tasks.every((t) => TERMINAL_TASK.includes(t.status))) return;
    this.setRun(runId, { status: 'done', finishedAt: Date.now() });
    const merged = tasks.filter((t) => t.status === 'merged').length;
    this.bus.notify('Run finished', `${merged}/${tasks.length} tasks merged — ${run.goal.slice(0, 100)}`, `/runs/${runId}`);
    void this.cleanupRun(runId).catch((e) => console.error('[cleanup]', (e as Error).message));
  }

  /** Remove worktrees; delete branches of tasks that did not make it (§7 Cleanup). */
  async cleanupRun(runId: string, opts: { allBranches?: boolean; mergedBranches?: boolean } = {}) {
    const run = this.db.getRun(runId);
    if (!run) return;
    const project = this.db.getProject(run.projectId);
    if (!project) return;
    for (const t of this.db.listTasks(runId)) {
      if (this.active.has(t.id)) continue;
      if (t.worktree && t.status !== 'awaiting_approval' && t.status !== 'pending') {
        await G.removeWorktree(project.path, t.worktree);
        this.setTask(t.id, { worktree: null });
      }
      const drop = opts.allBranches
        || (opts.mergedBranches && t.status === 'merged')
        || ['rejected', 'failed', 'stopped', 'no_changes'].includes(t.status);
      if (t.branch && drop) {
        if (t.worktree) await G.removeWorktree(project.path, t.worktree);
        await G.deleteBranch(project.path, t.branch);
        this.db.updateTask(t.id, { branch: null, worktree: null });
        this.bus.task(this.db.getTask(t.id));
      }
    }
  }

  // ---- tasks: user actions ------------------------------------------------------------------

  patchTask(taskId: string, patch: Partial<Pick<Task, 'title' | 'description' | 'provider' | 'model' | 'dependsOn' | 'type' | 'size'>>): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    if (t.status !== 'pending') throw new UserError('only pending tasks can be edited');
    const clean: Partial<Task> = {};
    if (patch.title !== undefined) clean.title = String(patch.title).slice(0, 200);
    if (patch.description !== undefined) clean.description = String(patch.description);
    if (patch.provider !== undefined) {
      if (!['claude', 'codex', 'gemini'].includes(patch.provider as string)) throw new UserError('invalid provider');
      clean.provider = patch.provider;
    }
    if (patch.model !== undefined) clean.model = String(patch.model);
    if (patch.type !== undefined) clean.type = patch.type;
    if (patch.size !== undefined) clean.size = patch.size;
    if (patch.dependsOn !== undefined) {
      if (!Array.isArray(patch.dependsOn)) throw new UserError('dependsOn must be an array');
      const tasks = this.db.listTasks(t.runId);
      const keys = new Set(tasks.map((x) => x.key));
      for (const d of patch.dependsOn) if (!keys.has(d) || d === t.key) throw new UserError(`invalid dependency ${d}`);
      try { topoSort(tasks.map((x) => (x.id === t.id ? { key: x.key, dependsOn: patch.dependsOn! } : x))); } catch (e) { throw new UserError((e as Error).message); }
      clean.dependsOn = patch.dependsOn.map(String);
    }
    return this.setTask(taskId, clean);
  }

  async stopTask(taskId: string): Promise<void> {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    const a = this.active.get(taskId);
    if (a) {
      a.ctrl.abort();
      // Wait for the job to unwind so callers see the final state.
      for (let i = 0; i < 200 && this.active.has(taskId); i++) await new Promise((r) => setTimeout(r, 50));
      return;
    }
    if (t.status === 'pending' || t.status === 'waiting_limit') this.setTask(taskId, { status: 'stopped', finishedAt: Date.now() });
  }

  async approve(taskId: string): Promise<Task> {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    if (t.status !== 'awaiting_approval') throw new UserError(`task is ${t.status}, not awaiting approval`);
    if (!t.branch) throw new UserError('task has no branch');
    const run = this.db.getRun(t.runId)!;
    const project = this.project(run);
    const branch = await G.currentBranch(project.path);
    if (branch !== run.baseBranch) {
      throw new UserError(`The project is on branch "${branch}", but this run started from "${run.baseBranch}". Check out ${run.baseBranch} in ${project.path} and try again.`, 409);
    }
    const dirty = await G.statusPorcelain(project.path);
    if (dirty.length) {
      throw new UserError(`The project has uncommitted changes (${dirty.length} file${dirty.length === 1 ? '' : 's'}, untracked included). Commit or stash them in ${project.path} before merging.`, 409, { files: dirty.slice(0, 50) });
    }
    const res = await G.mergeInto(project.path, t.branch, `Ensemble: ${t.title}`, true);
    if (!res.ok) {
      this.emit(run.id, t.id, t.provider, { kind: 'error', text: `Merge conflict in ${res.conflicts.join(', ') || 'unknown files'}. Use "Rebase onto current branch".`, data: { conflicts: res.conflicts } });
      throw new UserError('Merge conflict — the merge was aborted. Use "Rebase onto current branch" to update the task.', 409, { conflicts: res.conflicts });
    }
    this.db.setOutcomeApproved(t.id, true);
    this.emit(run.id, t.id, t.provider, { kind: 'status', text: `Merged ${t.branch} into ${run.baseBranch} (--no-ff)` });
    const out = this.setTask(t.id, { status: 'merged', finishedAt: Date.now() });
    if (t.worktree) { await G.removeWorktree(project.path, t.worktree); this.db.updateTask(t.id, { worktree: null }); }
    return this.db.getTask(t.id) ?? out;
  }

  reject(taskId: string, reason?: string): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    if (t.status !== 'awaiting_approval') throw new UserError(`task is ${t.status}, not awaiting approval`);
    this.db.setOutcomeApproved(t.id, false);
    if (reason) this.emit(t.runId, t.id, t.provider, { kind: 'log', text: `Rejected: ${reason}` });
    return this.setTask(t.id, { status: 'rejected', rejectReason: reason ?? null, finishedAt: Date.now() });
  }

  retry(taskId: string, opts: { provider?: RealProviderId; model?: string; instructions?: string } = {}): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    if (t.status === 'merged') throw new UserError('merged tasks cannot be retried');
    if (this.active.has(taskId)) throw new UserError('task is running — stop it first');
    if (opts.provider && !['claude', 'codex', 'gemini'].includes(opts.provider)) throw new UserError('invalid provider');
    const run = this.db.getRun(t.runId)!;
    let provider = opts.provider ?? t.provider;
    let model = opts.model ?? (opts.provider && opts.provider !== t.provider ? '' : t.model);
    if (!provider) {
      const r = this.router.route(t.type, t.size);
      provider = r.provider; model = r.model;
    }
    const feedback = [opts.instructions?.trim(), t.rejectReason ? `A previous attempt was rejected by the user: ${t.rejectReason}` : null].filter(Boolean).join('\n\n') || null;
    const out = this.setTask(taskId, {
      status: 'pending', provider, model, feedback, attempts: 0, fixRounds: 0, testStatus: null, testOutput: null, review: null,
      summary: null, error: null, sessionId: null, startedAt: null, finishedAt: null, baseCommit: null, rejectReason: null,
    });
    this.emit(run.id, t.id, provider, { kind: 'status', text: `Retry requested${opts.provider ? ` (reassigned to ${provider}/${model || 'default'})` : ''}` });
    if (['done', 'stopped', 'failed'].includes(run.status)) this.setRun(run.id, { status: 'running', finishedAt: null });
    // Dependents that were failed because of this task get another chance too.
    for (const d of this.db.listTasks(run.id)) {
      if (d.status === 'failed' && d.dependsOn.includes(t.key) && d.error?.startsWith('dependency ')) {
        this.setTask(d.id, { status: 'pending', error: null, finishedAt: null });
      }
    }
    this.kick();
    return out;
  }

  /** Fresh worktree from the current base-branch HEAD, merge the task branch in, re-run tests + review. */
  async rebase(taskId: string): Promise<Task> {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    if (t.status !== 'awaiting_approval' || !t.branch) throw new UserError('only tasks awaiting approval can be rebased');
    const run = this.db.getRun(t.runId)!;
    const project = this.project(run);
    const head = await G.headCommit(project.path);
    const n = (t.branch.match(/-r(\d+)$/)?.[1] ?? '0');
    const { branch, dir } = this.worktreeFor(project, run, t.key, `-r${Number(n) + 1}`);
    await G.addWorktree({ repo: project.path, branch, dir, base: head });
    const merged = await G.mergeInto(dir, t.branch, `Rebase ${t.key} onto ${run.baseBranch}`);
    if (!merged.ok) {
      await G.removeWorktree(project.path, dir);
      await G.deleteBranch(project.path, branch);
      throw new UserError(`Conflicts while rebasing (${merged.conflicts.join(', ')}). Retry the task instead.`, 409, { conflicts: merged.conflicts });
    }
    const oldWt = t.worktree;
    const oldBranch = t.branch;
    this.setTask(t.id, { branch, worktree: dir, baseCommit: head, status: 'pending' });
    if (oldWt) await G.removeWorktree(project.path, oldWt);
    await G.deleteBranch(project.path, oldBranch);
    this.emit(run.id, t.id, t.provider, { kind: 'status', text: `Rebased onto ${run.baseBranch} @ ${head.slice(0, 8)}; re-running tests and review` });
    this.beginJob(this.db.getTask(t.id)!, async (task, signal) => {
      await this.setupWorktree(project, run, task, signal);
      await this.testAndReview(run, project, task, signal);
    });
    return this.db.getTask(t.id)!;
  }

  async diff(taskId: string): Promise<{ stat: string; diff: string; truncated: boolean }> {
    const t = this.db.getTask(taskId);
    if (!t) throw new UserError('task not found', 404);
    const run = this.db.getRun(t.runId)!;
    const project = this.project(run);
    if (!t.branch || !(await G.branchExists(project.path, t.branch))) return { stat: '', diff: '', truncated: false };
    const base = t.baseCommit ?? run.baseCommit!;
    const [stat, d] = await Promise.all([G.diffStat(project.path, base, t.branch), G.diff(project.path, base, t.branch)]);
    return { stat, diff: d.length > DIFF_DISPLAY ? d.slice(0, DIFF_DISPLAY) : d, truncated: d.length > DIFF_DISPLAY };
  }

  // ---- AGENTS.md draft ------------------------------------------------------------------------

  async draftAgentsMd(projectId: string): Promise<{ runId: string; content: string }> {
    const project = this.db.getProject(projectId);
    if (!project) throw new UserError('project not found', 404);
    const run = this.db.createRun({ projectId, goal: 'Draft AGENTS.md', status: 'running', baseBranch: null, baseCommit: null, lead: this.cfg().lead, pseudo: true });
    this.bus.run(run);
    const ctrl = new AbortController();
    const prompt = agentsMdPrompt({ projectName: project.name, stack: project.stack, tree: fileTree(project.path) });
    let lastError = 'no provider available';
    for (const ref of this.planCandidates(this.cfg().lead)) {
      if (this.limits.isLimited(ref.provider)) continue;
      const res = await this.invoke({ run, task: null, ref, role: 'agents_md', cwd: project.path, prompt, readOnly: true, signal: ctrl.signal });
      if (res.limited) { this.limits.record(ref.provider, res.limited, run.id); continue; }
      if (res.ok && res.finalText.trim()) {
        this.setRun(run.id, { status: 'done', finishedAt: Date.now() });
        return { runId: run.id, content: cleanMarkdownReply(res.finalText) };
      }
      lastError = res.error ?? 'empty reply';
    }
    this.setRun(run.id, { status: 'failed', error: lastError, finishedAt: Date.now() });
    throw new UserError(`Could not draft AGENTS.md: ${lastError}`, 502);
  }

  // ---- restart safety (§8.4) ------------------------------------------------------------------

  recoverAfterRestart() {
    for (const t of this.db.tasksByStatus(ACTIVE_TASK)) {
      this.db.updateTask(t.id, { status: 'failed', error: 'interrupted by restart', finishedAt: Date.now() });
      this.db.insertEvent(t.runId, t.id, t.provider, { kind: 'error', text: 'Task interrupted by a server restart — use Retry to run it again (worktree contents are kept).' });
    }
    for (const r of this.db.listRuns(undefined, true)) {
      if (r.status === 'planning' || (r.pseudo && r.status === 'running')) {
        this.db.updateRun(r.id, { status: 'failed', error: 'interrupted by restart', finishedAt: Date.now() });
      }
    }
  }

  // ---- scheduler entry point ------------------------------------------------------------------

  /** Mark a dependent task failed because a dependency didn't complete. */
  failDependent(t: Task, depKey: string) {
    this.setTask(t.id, { status: 'failed', error: `dependency ${depKey} did not complete`, finishedAt: Date.now() });
  }

  /** Re-route a pending task whose provider is limited (handoff policy). Returns false if nothing else is available. */
  rerouteLimited(t: Task): boolean {
    try {
      const r = this.router.route(t.type, t.size, { exclude: t.provider ? [t.provider] : [] });
      if (r.limited) return false;
      this.setTask(t.id, { provider: r.provider, model: r.model });
      this.emit(t.runId, t.id, r.provider, { kind: 'status', text: `${t.provider} is usage-limited; reassigned to ${r.provider}/${r.model || 'default'}` });
      return true;
    } catch { return false; }
  }

  assign(t: Task): Task | null {
    try {
      const r = this.router.route(t.type, t.size);
      return this.setTask(t.id, { provider: r.provider, model: r.model });
    } catch (e) {
      if (e instanceof NoProviderError) {
        this.setTask(t.id, { status: 'failed', error: e.message, finishedAt: Date.now() });
        return null;
      }
      throw e;
    }
  }

  /** Start a task job (synchronously marks it active so the scheduler's counts stay correct). */
  startTask(t: Task, mode: StartMode) {
    const run = this.db.getRun(t.runId)!;
    const project = this.project(run);
    this.beginJob(t, async (task, signal) => {
      if (mode === 'fresh') await this.prepareWorktree(project, run, task, signal);
      await this.workAndPipeline(run, project, task, mode, signal);
    });
  }

  private beginJob(t: Task, body: (task: Task, signal: AbortSignal) => Promise<void>) {
    const ctrl = new AbortController();
    this.active.set(t.id, { ctrl, provider: t.provider });
    const task = this.setTask(t.id, { status: 'running', startedAt: t.startedAt ?? Date.now(), finishedAt: null, error: null });
    void (async () => {
      try {
        await body(task, ctrl.signal);
      } catch (e) {
        if (!(e instanceof Halt) && !this.shuttingDown) {
          try {
            const msg = (e as Error).message || String(e);
            this.emit(t.runId, t.id, t.provider, { kind: 'error', text: msg });
            const cur = this.db.getTask(t.id);
            if (cur && !TERMINAL_TASK.includes(cur.status) && cur.status !== 'awaiting_approval' && cur.status !== 'waiting_limit') {
              this.setTask(t.id, ctrl.signal.aborted ? { status: 'stopped', finishedAt: Date.now() } : { status: 'failed', error: msg, finishedAt: Date.now() });
            }
          } catch (inner) { console.error('[pipeline]', inner); }
        }
      } finally {
        this.active.delete(t.id);
        if (!this.shuttingDown) { this.onProvidersChanged(); this.kick(); }
      }
    })().catch((e) => console.error('[pipeline]', e));
  }

  /** Set during server shutdown: jobs unwind without touching task state, so a restart marks them interrupted. */
  shuttingDown = false;

  private halt(taskId: string, status: TaskStatus, error?: string): never {
    if (this.shuttingDown) throw new Halt();
    this.setTask(taskId, { status, error: error ?? null, finishedAt: TERMINAL_TASK.includes(status) ? Date.now() : null });
    throw new Halt();
  }

  // ---- task lifecycle -------------------------------------------------------------------------

  private async prepareWorktree(project: Project, run: Run, task: Task, signal: AbortSignal) {
    const { branch, dir } = this.worktreeFor(project, run, task.key);
    this.emit(run.id, task.id, null, { kind: 'status', text: `Creating worktree ${dir}` });
    await G.addWorktree({ repo: project.path, branch, dir, base: run.baseCommit! });
    this.setTask(task.id, { branch, worktree: dir, baseCommit: null });
    // Merge dependency branches so the task builds on its parents' work.
    const tasks = this.db.listTasks(run.id);
    for (const key of task.dependsOn) {
      const dep = tasks.find((x) => x.key === key);
      if (!dep?.branch || !(await G.branchExists(project.path, dep.branch))) continue;
      const res = await G.mergeInto(dir, dep.branch, `Merge dependency ${key}`);
      if (!res.ok) {
        this.emit(run.id, task.id, null, { kind: 'error', text: `Dependency branches conflict (${key}: ${res.conflicts.join(', ')})`, data: { conflicts: res.conflicts } });
        this.halt(task.id, 'failed', 'dependency branches conflict');
      }
      this.emit(run.id, task.id, null, { kind: 'status', text: `Merged dependency ${key} (${dep.branch})` });
    }
    await this.setupWorktree(project, run, this.db.getTask(task.id)!, signal);
  }

  private async setupWorktree(project: Project, run: Run, task: Task, signal: AbortSignal) {
    const dir = task.worktree!;
    if (project.linkNodeModules) {
      const dirs = nodeModulesDirs(project.path);
      for (const rel of dirs) {
        const target = path.join(project.path, rel, 'node_modules');
        const link = path.join(dir, rel, 'node_modules');
        if (!fs.existsSync(path.join(dir, rel))) continue;
        try { fs.lstatSync(link); continue; } catch { /* missing — create */ }
        fs.symlinkSync(target, link, 'dir');
      }
      if (dirs.length) {
        let ignored = false;
        try { await G.git(dir, ['check-ignore', '-q', 'node_modules']); ignored = true; } catch { /* not ignored */ }
        if (!ignored) await G.addExclude(dir, 'node_modules');
        this.emit(run.id, task.id, null, { kind: 'log', text: `Linked node_modules (${dirs.join(', ')})` });
      }
    }
    if (project.setupCommand) {
      const res = await this.shell(run, task, project.setupCommand, dir, signal, 'setup');
      if (signal.aborted) this.halt(task.id, 'stopped');
      if (res.code !== 0) this.halt(task.id, 'failed', `setup command failed (exit ${res.code ?? res.signal})`);
    }
  }

  /** The only place a shell is used: the user's own test/setup commands (§8.2). */
  private async shell(run: Run, task: Task, command: string, cwd: string, signal: AbortSignal, label: 'test' | 'setup') {
    this.emit(run.id, task.id, null, { kind: 'command', text: command, data: { command, status: 'started', label } });
    let output = '';
    let pending: string[] = [];
    const flush = () => {
      if (!pending.length) return;
      this.emit(run.id, task.id, null, { kind: 'log', text: pending.join('\n'), data: { stream: label } });
      pending = [];
    };
    const timer = setInterval(flush, 750);
    const onLine = (l: string) => {
      output += l + '\n';
      if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
      pending.push(l);
      if (pending.length >= 200) flush();
    };
    const res = await runProcess('/bin/sh', ['-c', command], {
      cwd, timeoutMs: this.cfg().testTimeoutMinutes * 60_000, signal,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      onStdoutLine: onLine, onStderrLine: onLine,
    });
    clearInterval(timer);
    flush();
    const tail = output.length > TEST_TAIL ? output.slice(-TEST_TAIL) : output;
    const exit = res.timedOut ? 'timeout' : res.code;
    this.emit(run.id, task.id, null, { kind: 'command', text: command, data: { command, status: 'completed', exitCode: exit, output: tail, label } });
    return { ...res, tail };
  }

  private async commit(run: Run, task: Task, message?: string) {
    const msg = message ?? `${task.title}\n\nEnsemble run ${run.id} task ${task.key} by ${task.provider}/${task.model || 'default'}`;
    const did = await G.commitAll(task.worktree!, msg);
    if (did) this.emit(run.id, task.id, task.provider, { kind: 'log', text: `Committed: ${msg.split('\n')[0]}` });
    return did;
  }

  /**
   * One agent step with the automatic-retry and limit policies applied.
   * Returns the result, or throws Halt after setting the task's status.
   */
  private async step(run: Run, task: Task, role: AgentRole, prompt: string, signal: AbortSignal, resume?: string): Promise<StepOutcome> {
    const ref = { provider: task.provider!, model: task.model };
    let res = await this.invoke({ run, task, ref, role, cwd: task.worktree!, prompt, readOnly: false, signal, resumeSessionId: resume });
    if (signal.aborted) return { kind: 'stopped' };
    if (res.limited) return { kind: 'limited', result: res };
    if (!res.ok) {
      this.emit(run.id, task.id, ref.provider, { kind: 'status', text: 'Agent failed — retrying once automatically' });
      res = await this.invoke({ run, task, ref, role, cwd: task.worktree!, prompt, readOnly: false, signal, resumeSessionId: res.sessionId ?? resume });
      if (signal.aborted) return { kind: 'stopped' };
      if (res.limited) return { kind: 'limited', result: res };
      if (!res.ok) return { kind: 'failed', error: res.error ?? 'agent failed' };
    }
    return { kind: 'ok', result: res };
  }

  /**
   * Apply the limit policy (§11). Returns the updated task when the job should continue
   * with a handoff, or throws Halt when the task now waits.
   */
  private async onLimited(run: Run, task: Task, res: AgentResult): Promise<Task> {
    const provider = task.provider!;
    this.limits.record(provider, res.limited!, run.id, task.id);
    this.onProvidersChanged();
    if (res.sessionId) task = this.setTask(task.id, { sessionId: res.sessionId });
    await this.commit(run, task, `WIP: interrupted ${provider}`);
    if (this.cfg().onLimit === 'handoff') {
      let next: ModelRef | null = null;
      try {
        const r = this.router.route(task.type, task.size, { exclude: [provider] });
        if (!r.limited) next = r;
      } catch { /* none */ }
      if (next) {
        const previous = res.finalText || this.db.lastEventText(task.id, ['text']);
        const updated = this.setTask(task.id, { provider: next.provider, model: next.model, handoffs: task.handoffs + 1, sessionId: null, summary: previous ? truncate(previous, SUMMARY_MAX) : task.summary });
        const a = this.active.get(task.id);
        if (a) a.provider = next.provider;
        this.emit(run.id, task.id, next.provider, { kind: 'status', text: `Handing off from ${provider} to ${next.provider}/${next.model || 'default'}`, data: { from: provider, to: next.provider } });
        return updated;
      }
      this.emit(run.id, task.id, provider, { kind: 'status', text: 'No other provider available — waiting for the limit to reset' });
    }
    this.halt(task.id, 'waiting_limit', `waiting for ${provider} limit to reset`);
  }

  private async workAndPipeline(run: Run, project: Project, task: Task, mode: StartMode, signal: AbortSignal) {
    let t = this.db.getTask(task.id)!;
    let currentMode = mode;
    let handoffFrom = 'another agent';
    for (;;) {
      const all = this.db.listTasks(run.id);
      let prompt: string;
      let resume: string | undefined;
      if (currentMode === 'handoff') {
        const stat = await G.git(t.worktree!, ['diff', '--stat', t.baseCommit ?? run.baseCommit!]).catch(() => '');
        prompt = handoffPrompt({ goal: run.goal, planSummary: run.planSummary, tasks: all, task: t, fromProvider: handoffFrom, previousText: t.summary, diffStat: stat });
      } else if (currentMode === 'continue' && t.sessionId) {
        prompt = CONTINUE_PROMPT;
        resume = t.sessionId;
      } else {
        const depSummaries = t.dependsOn.map((k) => all.find((x) => x.key === k)).filter(Boolean).map((d) => ({ key: d!.key, title: d!.title, summary: d!.summary }));
        prompt = workPrompt({ goal: run.goal, planSummary: run.planSummary, tasks: all, task: t, depSummaries, feedback: t.feedback });
      }
      const out = await this.step(run, t, 'work', prompt, signal, resume);
      if (out.kind === 'stopped') { await this.commit(run, t, `WIP: stopped ${t.provider}`).catch(() => {}); this.halt(t.id, 'stopped'); }
      if (out.kind === 'failed') this.halt(t.id, 'failed', out.error);
      if (out.kind === 'limited') { handoffFrom = t.provider ?? handoffFrom; t = await this.onLimited(run, t, out.result); currentMode = 'handoff'; continue; }
      t = this.setTask(t.id, { sessionId: out.result.sessionId ?? t.sessionId, summary: truncate(out.result.finalText || '(no summary)', SUMMARY_MAX) });
      break;
    }
    await this.commit(run, t);
    const base = t.baseCommit ?? run.baseCommit!;
    const ahead = await G.commitsAhead(project.path, base, t.branch!);
    const changed = ahead > 0 ? (await G.git(project.path, ['diff', '--name-only', `${base}...${t.branch}`])).trim() : '';
    if (!changed) this.halt(t.id, 'no_changes');
    await this.testAndReview(run, project, t, signal);
  }

  private async runTests(run: Run, project: Project, t: Task, signal: AbortSignal): Promise<Task> {
    t = this.setTask(t.id, { status: 'testing' });
    if (!project.testCommand) {
      this.emit(run.id, t.id, null, { kind: 'test', text: 'No test command configured — skipped', data: { status: 'skipped' } });
      return this.setTask(t.id, { testStatus: 'skipped', testOutput: null });
    }
    const res = await this.shell(run, t, project.testCommand, t.worktree!, signal, 'test');
    if (signal.aborted) this.halt(t.id, 'stopped');
    const pass = res.code === 0 && !res.timedOut;
    this.emit(run.id, t.id, null, {
      kind: 'test', text: pass ? 'Tests passed' : res.timedOut ? 'Tests timed out' : `Tests failed (exit ${res.code})`,
      data: { status: pass ? 'pass' : 'fail', exitCode: res.code, output: res.tail },
    });
    return this.setTask(t.id, { testStatus: pass ? 'pass' : 'fail', testOutput: res.tail });
  }

  private async fix(run: Run, project: Project, t: Task, reason: 'tests' | 'review', details: string, signal: AbortSignal): Promise<Task> {
    t = this.setTask(t.id, { status: 'fixing' });
    for (;;) {
      const fresh = !t.sessionId;
      const prompt = fixPrompt({ goal: run.goal, task: t, reason, details, fresh });
      const out = await this.step(run, t, 'fix', prompt, signal, t.sessionId ?? undefined);
      if (out.kind === 'stopped') this.halt(t.id, 'stopped');
      if (out.kind === 'failed') this.halt(t.id, 'failed', out.error);
      if (out.kind === 'limited') { t = await this.onLimited(run, t, out.result); continue; }
      t = this.setTask(t.id, { sessionId: out.result.sessionId ?? t.sessionId, summary: truncate([t.summary, `Fix (${reason}): ${out.result.finalText}`].filter(Boolean).join('\n\n'), SUMMARY_MAX) });
      await this.commit(run, t, `Fix ${reason === 'tests' ? 'test failures' : 'review issues'}: ${t.title}\n\nEnsemble run ${run.id} task ${t.key} by ${t.provider}/${t.model || 'default'}`);
      return t;
    }
  }

  private async testAndReview(run: Run, project: Project, task: Task, signal: AbortSignal) {
    const cfg = this.cfg();
    let t = this.db.getTask(task.id)!;
    let firstTryPass: boolean | null = null;
    let firstCritical: number | null = null;
    const started = t.startedAt ?? Date.now();
    for (;;) {
      t = await this.runTests(run, project, t, signal);
      firstTryPass ??= t.testStatus !== 'fail';
      if (t.testStatus === 'fail' && t.attempts < cfg.maxTestRetries) {
        t = this.setTask(t.id, { attempts: t.attempts + 1 });
        t = await this.fix(run, project, t, 'tests', t.testOutput ?? '', signal);
        continue;
      }
      const review = await this.review(run, project, t, signal);
      t = this.setTask(t.id, { review });
      firstCritical ??= review.critical.length;
      if (review.verdict === 'changes' && review.critical.length && t.fixRounds < cfg.maxReviewFixRounds) {
        t = this.setTask(t.id, { fixRounds: t.fixRounds + 1 });
        t = await this.fix(run, project, t, 'review', review.critical.map((c, i) => `${i + 1}. ${c}`).join('\n'), signal);
        continue;
      }
      break;
    }
    t = this.setTask(t.id, { status: 'awaiting_approval' });
    this.db.insertOutcome({
      taskId: t.id, provider: t.provider!, model: t.model, taskType: t.type, firstTryPass: !!firstTryPass,
      criticalIssues: firstCritical ?? 0, durationMs: Date.now() - started,
    });
    this.bus.notify('Task ready for review', t.title, `/runs/${run.id}`);
  }

  private reviewerFor(t: Task): { ref: ModelRef; selfReview: boolean } | null {
    const author = t.provider!;
    try {
      const r = this.router.route('review', t.size, { exclude: [author] });
      if (!r.limited) return { ref: r, selfReview: false };
    } catch { /* fall through */ }
    if (!this.adapters.usable(author) || this.limits.isLimited(author)) return null;
    const alt = this.cfg().routing.review.find((c) => c.provider === author && c.model !== t.model)
      ?? Object.values(this.cfg().routing).flat().find((c) => c.provider === author && c.model !== t.model);
    return { ref: { provider: author, model: alt?.model ?? t.model }, selfReview: true };
  }

  private async review(run: Run, project: Project, t: Task, signal: AbortSignal): Promise<ReviewResult> {
    this.setTask(t.id, { status: 'reviewing' });
    const base = t.baseCommit ?? run.baseCommit!;
    const [stat, full] = await Promise.all([G.diffStat(project.path, base, t.branch!), G.diff(project.path, base, t.branch!)]);
    const diffText = full.length > DIFF_REVIEW ? full.slice(0, DIFF_REVIEW) : full;
    const prompt = reviewPrompt({
      goal: run.goal, task: t, authorSummary: t.summary, testStatus: t.testStatus, testOutput: t.testStatus === 'fail' ? t.testOutput : null,
      stat, diff: diffText, diffTruncated: full.length > DIFF_REVIEW,
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const pick = this.reviewerFor(t);
      if (!pick) break;
      if (pick.selfReview) this.emit(run.id, t.id, pick.ref.provider, { kind: 'log', text: 'No other provider is available — the author provider reviews with a different model (self-review).', data: { warning: true } });
      const res = await this.invoke({ run, task: t, ref: pick.ref, role: 'review', cwd: t.worktree!, prompt, readOnly: true, signal });
      if (signal.aborted) this.halt(t.id, 'stopped');
      if (res.limited) { this.limits.record(pick.ref.provider, res.limited, run.id, t.id); this.onProvidersChanged(); continue; }
      if (!res.ok) { this.emit(run.id, t.id, pick.ref.provider, { kind: 'log', text: `Reviewer failed: ${res.error}` }); continue; }
      const parsed = parseReview(res.finalText);
      const result: ReviewResult = { ...parsed, reviewer: pick.ref, ...(pick.selfReview ? { selfReview: true } : {}) };
      if (t.testStatus === 'fail') result.notes = [`Tests still failing after ${t.attempts} fix attempt(s).`, ...result.notes];
      this.emit(run.id, t.id, pick.ref.provider, {
        kind: 'review', text: `${result.verdict === 'approve' ? 'Approved' : 'Changes requested'} by ${pick.ref.provider}/${pick.ref.model || 'default'}${result.selfReview ? ' (self-review)' : ''}`,
        data: result as unknown as Record<string, unknown>,
      });
      return result;
    }
    const skipped: ReviewResult = {
      verdict: 'approve', critical: [], notes: ['Review skipped: no reviewer was available (all providers limited, missing, or failing).'],
      reviewer: { provider: t.provider!, model: t.model }, parseFailed: true,
    };
    this.emit(run.id, t.id, null, { kind: 'review', text: 'Review skipped — no reviewer available', data: skipped as unknown as Record<string, unknown> });
    return skipped;
  }

  // ---- stack refresh helper used by the API --------------------------------------------------

  refreshStack(project: Project): Project {
    return this.db.updateProject(project.id, { stack: detectStack(project.path) })!;
  }

  settledForDependents(status: TaskStatus) {
    return SETTLED_TASK.includes(status);
  }
}

function safeName(s: string) {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'project';
}
