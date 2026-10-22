import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { FeedBody } from '../components/AgentFeed';
import { Modal } from '../components/Modal';
import { StatusChip } from '../components/ProviderBadge';
import { errorToast, navigate, toast } from '../store';
import type { Config, ProjectInfo, RunListItem, StoredEvent } from '../types';
import { socket } from '../ws';
import { ago, fmtDuration } from '../util';

function AgentsMdEditor({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState(true);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    // Live log: the draft job's pseudo-run is broadcast before the agent starts.
    let pseudo: string | null = null;
    const off = socket.on((m) => {
      if (m.type === 'run' && m.run.pseudo && m.run.projectId === projectId && m.run.status === 'running') { pseudo = m.run.id; setRunId(m.run.id); }
      if (m.type === 'event' && pseudo && m.event.runId === pseudo) setEvents((e) => [...e, m.event]);
    });
    api.draftAgentsMd(projectId).then((r) => { setContent(r.content); setRunId(r.runId); }).catch((e) => setError(e.message));
    return off;
  }, [projectId]);

  const save = async () => {
    if (!content) return;
    try {
      const r = await api.saveAgentsMd(projectId, content, link);
      toast('Saved', r.written.join(', '));
      onSaved(); onClose();
    } catch (e) { errorToast(e); }
  };

  return (
    <Modal title="Draft AGENTS.md" onClose={onClose} footer={<>
      <label className="check"><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> Symlink CLAUDE.md and GEMINI.md to it (only if missing)</label>
      <button className="ghost" onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!content} onClick={save}>Save AGENTS.md</button>
    </>}>
      {error && <div className="banner bad">{error}</div>}
      {content === null && !error && (
        <div className="feed" style={{ height: 280 }}>
          <div className="feed-head"><span className="status s-running">drafting</span><span className="small dim">{runId ? `job ${runId}` : 'starting…'}</span></div>
          <FeedBody events={events} showLogs={false} />
        </div>
      )}
      {content !== null && <textarea className="mono" rows={22} value={content} onChange={(e) => setContent(e.target.value)} aria-label="AGENTS.md content" />}
      <div className="small dim">Nothing is written until you click Save.</div>
    </Modal>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [goal, setGoal] = useState(() => { try { return sessionStorage.getItem(`ensemble.goal.${id}`) ?? ''; } catch { return ''; } });
  const [lead, setLead] = useState('');
  const [reviewPlan, setReviewPlan] = useState<boolean | null>(null);
  const [testCmd, setTestCmd] = useState('');
  const [setupCmd, setSetupCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.projectInfo(id).then((i) => {
      setInfo(i);
      setTestCmd(i.project.testCommand ?? '');
      setSetupCmd(i.project.setupCommand ?? '');
    }).catch((e) => setError(e.message));
    api.runs(id).then(setRuns).catch(errorToast);
  }, [id]);
  useEffect(() => { load(); api.settings().then(setCfg).catch(errorToast); }, [load]);
  useEffect(() => socket.on((m) => { if (m.type === 'run' && m.run.projectId === id && !m.run.pseudo) api.runs(id).then(setRuns).catch(() => {}); }), [id]);
  useEffect(() => { try { sessionStorage.setItem(`ensemble.goal.${id}`, goal); } catch { /* ignore */ } }, [goal, id]);

  const leadOptions = useMemo(() => {
    if (!cfg) return [];
    const seen = new Set<string>();
    return [cfg.lead, ...cfg.routing.plan].filter((r) => { const k = `${r.provider}/${r.model}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }, [cfg]);

  if (error) return <div className="page narrow"><div className="banner bad">{error}</div></div>;
  if (!info) return <div className="page narrow"><div className="dim">Loading…</div></div>;
  const p = info.project;

  const saveCommands = async () => {
    try {
      const np = await api.patchProject(id, { testCommand: testCmd.trim() || null, setupCommand: setupCmd.trim() || null });
      setInfo({ ...info, project: np });
      toast('Saved', 'Project commands updated');
    } catch (e) { errorToast(e); }
  };

  const start = async () => {
    setBusy(true);
    try {
      const leadRef = lead ? leadOptions[Number(lead)] : undefined;
      const run = await api.createRun(id, goal.trim(), leadRef, reviewPlan ?? undefined);
      setGoal('');
      navigate(`/runs/${run.id}`);
    } catch (e) { errorToast(e); } finally { setBusy(false); }
  };

  const af = info.agentFiles;
  const dirtyCmds = (testCmd.trim() || null) !== p.testCommand || (setupCmd.trim() || null) !== p.setupCommand;

  return (
    <div className="page narrow">
      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          <h1>{p.name}</h1>
          <div className="row wrap">
            {info.branch && <span className="chip mono">⎇ {info.branch}</span>}
            {p.stack.kinds.map((k) => <span key={k} className="chip">{k}</span>)}
          </div>
        </div>
        <div className="small dim mono" style={{ wordBreak: 'break-all' }}>{p.path}</div>
        {!info.exists && <div className="banner bad" style={{ marginTop: 8 }}>This folder no longer exists.</div>}
        {info.branch === 'HEAD' && <div className="banner bad" style={{ marginTop: 8 }}>HEAD is detached — check out a branch before starting a run.</div>}
        {info.dirty && (
          <div className="banner warn" style={{ marginTop: 8 }}>
            Uncommitted changes ({info.dirtyFiles.length}{info.dirtyFiles.length >= 50 ? '+' : ''} files). Agents start from the last commit and won't see them, and merging requires a clean tree.
          </div>
        )}
        <div className="grid2" style={{ marginTop: 12, gap: 10 }}>
          <label className="field">Test command <span className="dim">(run in each worktree via /bin/sh)</span>
            <input className="mono" value={testCmd} onChange={(e) => setTestCmd(e.target.value)} placeholder={p.stack.suggestedTest ?? 'none — tests are skipped'} />
          </label>
          <label className="field">Setup command <span className="dim">(after creating a worktree)</span>
            <input className="mono" value={setupCmd} onChange={(e) => setSetupCmd(e.target.value)} placeholder={p.stack.suggestedSetup ?? 'none'} />
          </label>
        </div>
        <div className="spread" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <label className="check"><input type="checkbox" checked={p.linkNodeModules} onChange={(e) => api.patchProject(id, { linkNodeModules: e.target.checked }).then((np) => setInfo({ ...info, project: np })).catch(errorToast)} /> Symlink node_modules into worktrees</label>
          <button className="sm" disabled={!dirtyCmds} onClick={saveCommands}>Save commands</button>
        </div>
        <div className="spread" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <div className="row wrap small">
            {(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const).map((f) => (
              <span key={f} className="chip" style={{ color: af[f].exists ? 'var(--ok)' : 'var(--fg-3)' }}>{af[f].exists ? '✓' : '✗'} {f}{af[f].symlink ? ' →' : ''}</span>
            ))}
          </div>
          <button className="sm" onClick={() => setEditor(true)}>{af['AGENTS.md'].exists ? 'Redraft AGENTS.md' : 'Draft AGENTS.md'}</button>
        </div>
      </div>

      <div className="card">
        <h2>New run</h2>
        <div className="col">
          <textarea rows={4} placeholder="Describe the goal, e.g. “Add dark mode to the settings page and cover it with tests”" value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && goal.trim()) void start(); }} />
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <div className="row wrap">
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>Lead
                <select value={lead} onChange={(e) => setLead(e.target.value)}>
                  {leadOptions.map((r, i) => <option key={i} value={i === 0 ? '' : String(i)}>{r.provider}{r.model ? ` / ${r.model}` : ' (default model)'}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={reviewPlan ?? cfg?.reviewPlanBeforeStart ?? false} onChange={(e) => setReviewPlan(e.target.checked)} /> Review plan before starting</label>
            </div>
            <button className="primary" disabled={busy || !goal.trim() || info.branch === 'HEAD'} onClick={start}>Start run ⌘↵</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Runs</h2>
        {runs.length === 0 ? <div className="small dim">No runs yet.</div> : (
          <div className="list">
            {runs.map((r) => (
              <a key={r.id} className="list-item" href={`/runs/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/runs/${r.id}`); }}>
                <StatusChip status={r.status} />
                <div className="grow">
                  <div className="ellipsis">{r.goal}</div>
                  <div className="small dim">
                    {ago(r.createdAt)}{r.finishedAt ? ` · took ${fmtDuration(r.finishedAt - r.createdAt)}` : ''} · {r.taskCount} task{r.taskCount === 1 ? '' : 's'}
                    {Object.entries(r.taskCounts).map(([s, n]) => ` · ${n} ${s.replace(/_/g, ' ')}`).join('')}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="row"><button className="sm ghost danger" onClick={async () => {
        if (!confirm(`Remove ${p.name} from Ensemble? Files on disk are not touched.`)) return;
        try { await api.deleteProject(id); navigate('/'); } catch (e) { errorToast(e); }
      }}>Remove project from list</button></div>
      {editor && <AgentsMdEditor projectId={id} onClose={() => setEditor(false)} onSaved={load} />}
    </div>
  );
}
