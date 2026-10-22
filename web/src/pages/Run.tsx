import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allEvents, api } from '../api';
import { AgentFeed } from '../components/AgentFeed';
import { Markdown } from '../components/Markdown';
import { ProviderBadge, StatusChip } from '../components/ProviderBadge';
import { ReviewPanel, TaskActions } from '../components/ReviewPanel';
import { TaskGraph } from '../components/TaskGraph';
import { errorToast, navigate, toast } from '../store';
import type { Project, Run, StoredEvent, Task, TaskType } from '../types';
import { ACTIVE, fmtDuration, fmtTime, useMedia, useNow } from '../util';
import { socket } from '../ws';

const TYPES: TaskType[] = ['implement', 'refactor', 'ui', 'tests', 'small-fix', 'analysis', 'docs', 'architecture'];

function useRunData(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(0);
  const loading = useRef(true);
  const pending = useRef<StoredEvent[]>([]);

  const append = useCallback((evs: StoredEvent[]) => {
    const fresh = evs.filter((e) => e.id > lastId.current).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    lastId.current = fresh[fresh.length - 1].id;
    setEvents((cur) => [...cur, ...fresh]);
  }, []);

  const sync = useCallback(async () => {
    loading.current = true;
    try {
      const [detail, evs] = await Promise.all([api.run(id), allEvents(id, lastId.current)]);
      setRun(detail.run); setTasks(detail.tasks); setProject(detail.project);
      append(evs);
      append(pending.current);
      pending.current = [];
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { loading.current = false; }
  }, [id, append]);

  useEffect(() => {
    lastId.current = 0; pending.current = []; setEvents([]); setRun(null); setTasks([]);
    void sync();
    socket.send({ type: 'subscribe', runId: id });
    const offMsg = socket.on((m) => {
      if (m.type === 'event' && m.event.runId === id) {
        if (loading.current) pending.current.push(m.event); else append([m.event]);
      } else if (m.type === 'task' && m.task.runId === id) {
        setTasks((ts) => { const i = ts.findIndex((t) => t.id === m.task.id); if (i < 0) return [...ts, m.task]; const n = ts.slice(); n[i] = m.task; return n; });
      } else if (m.type === 'run' && m.run.id === id) setRun(m.run);
    });
    const offConn = socket.onConn((connected, reconnected) => {
      if (connected) { socket.send({ type: 'subscribe', runId: id }); if (reconnected) void sync(); }
    });
    return () => { offMsg(); offConn(); socket.send({ type: 'subscribe', runId: '' }); };
  }, [id, sync, append]);

  return { run, project, tasks, events, error, setTasks };
}

function PlanEditor({ tasks, onStart }: { tasks: Task[]; onStart: () => void }) {
  const save = (t: Task, patch: Partial<Task>) => { api.patchTask(t.id, patch).catch(errorToast); };
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2>Review the plan</h2>
        <button className="primary" onClick={onStart}>Start run ▶</button>
      </div>
      <div className="col">
        {tasks.map((t) => (
          <div key={t.id} className="review-item">
            <div className="row wrap">
              <strong className="mono">{t.key}</strong>
              <input className="grow" defaultValue={t.title} onBlur={(e) => e.target.value !== t.title && save(t, { title: e.target.value })} aria-label="Title" />
            </div>
            <textarea rows={3} defaultValue={t.description} onBlur={(e) => e.target.value !== t.description && save(t, { description: e.target.value })} aria-label="Description" />
            <div className="row wrap">
              <label className="field">Type
                <select defaultValue={t.type} onChange={(e) => save(t, { type: e.target.value as TaskType })}>{TYPES.map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <label className="field">Provider
                <select value={t.provider ?? ''} onChange={(e) => save(t, { provider: e.target.value as Task['provider'] })}>
                  {['claude', 'codex', 'gemini'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="field">Model
                <input defaultValue={t.model} placeholder="CLI default" onBlur={(e) => e.target.value !== t.model && save(t, { model: e.target.value })} style={{ width: 130 }} />
              </label>
              <label className="field grow">Depends on (keys, comma-separated)
                <input className="mono" defaultValue={t.dependsOn.join(', ')} onBlur={(e) => {
                  const deps = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  if (deps.join(',') !== t.dependsOn.join(',')) save(t, { dependsOn: deps });
                }} />
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunPage({ id }: { id: string }) {
  const { run, project, tasks, events, error } = useRunData(id);
  const [focus, setFocus] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const mobile = useMedia('(max-width: 720px)');
  const live = !!run && ['planning', 'running', 'paused', 'plan_review'].includes(run.status);
  const now = useNow(1000, live);

  const byTask = useMemo(() => {
    const m = new Map<string | null, StoredEvent[]>();
    for (const e of events) {
      const k = e.taskId ?? null;
      let arr = m.get(k);
      if (!arr) { arr = []; m.set(k, arr); }
      arr.push(e);
    }
    return m;
  }, [events]);

  if (error && !run) return <div className="page"><div className="banner bad">{error}</div></div>;
  if (!run) return <div className="page"><div className="dim">Loading…</div></div>;

  const awaiting = tasks.filter((t) => t.status === 'awaiting_approval');
  const focused = tasks.find((t) => t.id === focus) ?? null;
  const feedTasks = tasks.filter((t) => ACTIVE.includes(t.status) || t.status === 'waiting_limit' || t.id === focus);
  const planEvents = byTask.get(null) ?? [];
  const showPlanFeed = run.status === 'planning' || tasks.length === 0;
  const counts = tasks.reduce<Record<string, number>>((m, t) => { m[t.status] = (m[t.status] ?? 0) + 1; return m; }, {});
  const elapsed = (run.finishedAt ?? now) - run.createdAt;

  const act = (fn: () => Promise<unknown>, msg?: string) => fn().then(() => msg && toast(msg)).catch(errorToast);

  const feedTabs = [...(showPlanFeed || planEvents.length ? [{ id: '__plan', label: 'Plan' }] : []), ...feedTasks.map((t) => ({ id: t.id, label: t.key }))];
  const activeTab = tab && feedTabs.some((f) => f.id === tab) ? tab : (focus && feedTabs.some((f) => f.id === focus) ? focus : feedTabs.find((f) => f.id !== '__plan')?.id ?? feedTabs[0]?.id);

  const planFeed = <AgentFeed key="__plan" title={<span className="row"><strong>Planning</strong><ProviderBadge provider={run.lead.provider} model={run.lead.model} /></span>} events={planEvents} />;
  const taskFeed = (t: Task) => <AgentFeed key={t.id} task={t} events={byTask.get(t.id) ?? []} tall={t.id === focus && feedTasks.length === 1} extra={<TaskActions task={t} />} />;

  return (
    <div className="page" data-events={events.length} data-last-event={events[events.length - 1]?.id ?? 0}>
      <div className="card run-header">
        <div className="row small dim wrap">
          {project && <a href={`/projects/${project.id}`} onClick={(e) => { e.preventDefault(); navigate(`/projects/${project.id}`); }}>← {project.name}</a>}
          {run.baseBranch && <span className="chip mono">⎇ {run.baseBranch} @ {run.baseCommit?.slice(0, 7)}</span>}
          <span>started {fmtTime(run.createdAt)} · {fmtDuration(elapsed)}</span>
        </div>
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="run-goal grow">{run.goal}</div>
          <div className="row wrap">
            <StatusChip status={run.status} />
            {run.status === 'running' && <button onClick={() => act(() => api.pauseRun(run.id), 'Paused — running tasks will finish')}>⏸ Pause</button>}
            {run.status === 'paused' && <button onClick={() => act(() => api.resumeRun(run.id))}>▶ Resume</button>}
            {['planning', 'plan_review', 'running', 'paused'].includes(run.status) && (
              <button className="danger" onClick={() => { if (confirm('Stop this run? Running agents are aborted; their work so far is kept in the worktrees.')) void act(() => api.stopRun(run.id), 'Stopped'); }}>■ Stop</button>
            )}
            {['done', 'stopped', 'failed'].includes(run.status) && tasks.some((t) => t.status === 'merged' && t.branch) && (
              <button onClick={() => act(() => api.cleanupBranches(run.id), 'Merged branches deleted')}>Clean up branches</button>
            )}
            {['done', 'stopped', 'failed'].includes(run.status) && (
              <button className="ghost danger" onClick={() => { if (confirm('Delete this run, its worktrees and unmerged branches?')) void api.deleteRun(run.id).then(() => navigate(project ? `/projects/${project.id}` : '/')).catch(errorToast); }}>Delete</button>
            )}
          </div>
        </div>
        {run.error && <div className="banner bad">{run.error}</div>}
        {run.planSummary && <details><summary className="small muted">Plan summary</summary><Markdown text={run.planSummary} /></details>}
        {tasks.length > 0 && (
          <div className="row wrap small">{Object.entries(counts).map(([s, n]) => <span key={s} className="row" style={{ gap: 4 }}><StatusChip status={s} /><span className="dim">×{n}</span></span>)}</div>
        )}
      </div>

      {run.status === 'plan_review' && <PlanEditor tasks={tasks} onStart={() => act(() => api.startRun(run.id), 'Run started')} />}

      {awaiting.length > 0 && (
        <div className="card review-queue">
          <h2>Ready for review ({awaiting.length})</h2>
          <div className="col">{awaiting.map((t) => <ReviewPanel key={t.id} task={t} />)}</div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="card">
          <div className="spread"><h2>Tasks</h2><span className="small dim">click a task to follow it</span></div>
          <TaskGraph tasks={tasks} focused={focus} onFocus={(tid) => { setFocus(tid === focus ? null : tid); setTab(tid); }} />
        </div>
      )}

      {focused && (
        <div className="card">
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <div className="row wrap grow"><strong className="mono">{focused.key}</strong><strong>{focused.title}</strong></div>
            <div className="row wrap"><span className="chip">{focused.type}</span><span className="chip">{focused.size}</span><ProviderBadge provider={focused.provider} model={focused.model} showDefault /><StatusChip status={focused.status} /></div>
          </div>
          {focused.error && <div className="banner bad" style={{ marginTop: 8 }}>{focused.error}</div>}
          <details style={{ marginTop: 8 }}><summary className="small muted">Task description</summary><Markdown text={focused.description} /></details>
          {focused.dependsOn.length > 0 && <div className="small dim">Depends on {focused.dependsOn.join(', ')}</div>}
          {focused.feedback && <div className="small"><span className="muted">Extra instructions:</span> {focused.feedback}</div>}
          <div style={{ marginTop: 8 }}><TaskActions task={focused} /></div>
        </div>
      )}

      {(feedTabs.length > 0) && (mobile ? (
        <div className="col">
          <div className="tabs" role="tablist">
            {feedTabs.map((f) => {
              const t = tasks.find((x) => x.id === f.id);
              return <button key={f.id} role="tab" aria-selected={activeTab === f.id} className={activeTab === f.id ? 'active' : ''} onClick={() => setTab(f.id)}>{f.label}{t ? <StatusChip status={t.status} /> : null}</button>;
            })}
          </div>
          {activeTab === '__plan' ? planFeed : (() => { const t = tasks.find((x) => x.id === activeTab); return t ? taskFeed(t) : null; })()}
        </div>
      ) : (
        <div className="feeds">
          {(showPlanFeed) && planFeed}
          {feedTasks.map(taskFeed)}
        </div>
      ))}

      {!showPlanFeed && planEvents.length > 0 && !mobile && (
        <details className="card"><summary className="small muted">Planning log ({planEvents.length} events)</summary><div style={{ marginTop: 8 }}>{planFeed}</div></details>
      )}
    </div>
  );
}
