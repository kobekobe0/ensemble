import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { errorToast, toast } from '../store';
import type { Task } from '../types';
import { ACTIVE } from '../util';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { ProviderBadge, StatusChip } from './ProviderBadge';

const PROVIDERS = ['claude', 'codex', 'gemini'] as const;

function RetryDialog({ task, mode, onClose }: { task: Task; mode: 'retry' | 'reassign' | 'reject'; onClose: () => void }) {
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<string>(task.provider ?? 'claude');
  const [model, setModel] = useState(mode === 'reassign' ? '' : task.model);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'reject') { await api.reject(task.id, text.trim() || undefined); toast('Rejected', task.title); }
      else if (mode === 'reassign') { await api.retry(task.id, { provider, model, instructions: text.trim() || undefined }); toast('Reassigned', `${task.key} → ${provider}${model ? '/' + model : ''}`); }
      else { await api.retry(task.id, { instructions: text.trim() || undefined }); toast('Retrying', task.title); }
      onClose();
    } catch (e) { errorToast(e); } finally { setBusy(false); }
  };
  const title = mode === 'reject' ? `Reject ${task.key}` : mode === 'reassign' ? `Reassign ${task.key}` : `Retry ${task.key} with feedback`;
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="ghost" onClick={onClose}>Cancel</button><button className={mode === 'reject' ? 'danger' : 'primary'} disabled={busy} onClick={submit}>{mode === 'reject' ? 'Reject' : 'Start'}</button></>}>
      {mode === 'reassign' && (
        <div className="row wrap">
          <label className="field">Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </label>
          <label className="field grow">Model
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="CLI default" />
          </label>
        </div>
      )}
      <label className="field">{mode === 'reject' ? 'Reason (optional — used if you later Retry with feedback)' : 'Extra instructions (optional)'}
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </label>
      {mode !== 'reject' && <div className="small dim">The task's worktree is reset to the run's base commit (plus dependency branches) and the agent starts over.</div>}
    </Modal>
  );
}

export function TaskActions({ task }: { task: Task }) {
  const [dialog, setDialog] = useState<null | 'retry' | 'reassign' | 'reject'>(null);
  const active = ACTIVE.includes(task.status);
  return (
    <>
      <div className="actions">
        {(active || task.status === 'waiting_limit' || task.status === 'pending') && <button className="danger sm" onClick={() => api.stopTask(task.id).catch(errorToast)}>Stop task</button>}
        {!active && task.status !== 'merged' && task.status !== 'awaiting_approval' && task.status !== 'pending' && (
          <>
            <button className="sm" onClick={() => setDialog('retry')}>Retry…</button>
            <button className="sm" onClick={() => setDialog('reassign')}>Reassign…</button>
          </>
        )}
      </div>
      {dialog && <RetryDialog task={task} mode={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

export function ReviewPanel({ task }: { task: Task }) {
  const [diff, setDiff] = useState<{ stat: string; diff: string; truncated: boolean } | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const [dialog, setDialog] = useState<null | 'retry' | 'reassign' | 'reject'>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; conflicts?: string[]; files?: string[] } | null>(null);

  useEffect(() => {
    let alive = true;
    api.diff(task.id).then((d) => { if (alive) setDiff(d); }).catch(() => {});
    return () => { alive = false; };
  }, [task.id, task.branch, task.fixRounds, task.attempts]);

  const approve = async () => {
    setBusy(true); setProblem(null);
    try { await api.approve(task.id); toast('Merged', task.title); }
    catch (e) {
      const err = e as ApiError;
      setProblem({ message: err.message, conflicts: err.body?.conflicts, files: err.body?.files });
    } finally { setBusy(false); }
  };
  const rebase = async () => {
    setBusy(true);
    try { await api.rebase(task.id); setProblem(null); toast('Rebasing', 'Re-running tests and review on the current branch'); }
    catch (e) { setProblem({ message: (e as Error).message, conflicts: (e as ApiError).body?.conflicts }); }
    finally { setBusy(false); }
  };

  const r = task.review;
  return (
    <div className="review-item">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <div className="row wrap grow">
          <strong className="mono">{task.key}</strong>
          <strong className="ellipsis">{task.title}</strong>
        </div>
        <div className="row wrap">
          <ProviderBadge provider={task.provider} model={task.model} />
          <StatusChip status={task.status} />
        </div>
      </div>

      <div className="row wrap small">
        <span>Tests: {task.testStatus === 'pass' ? <span className="badge-pass">passed</span> : task.testStatus === 'fail' ? <span className="badge-fail">failing</span> : <span className="dim">skipped</span>}</span>
        {r && (
          <span>· Review by <ProviderBadge provider={r.reviewer.provider} model={r.reviewer.model} />: {r.verdict === 'approve' ? <span className="badge-pass">approve</span> : <span className="badge-fail">changes requested</span>}</span>
        )}
        {r?.selfReview && <span className="status s-waiting_limit" title="No other provider was available, so the author's provider reviewed with a different model">self-review</span>}
        {r?.parseFailed && <span className="status s-waiting_limit" title="The reviewer output could not be parsed">⚠ review unparsed</span>}
        {task.fixRounds > 0 && <span className="dim">· {task.fixRounds} review fix round</span>}
        {task.attempts > 0 && <span className="dim">· {task.attempts} test fix attempt{task.attempts > 1 ? 's' : ''}</span>}
      </div>

      {r && r.critical.length > 0 && (<div><div className="small badge-fail">Critical issues</div><ul className="issues critical">{r.critical.map((c, i) => <li key={i}>{c}</li>)}</ul></div>)}
      {r && r.notes.length > 0 && (<div><div className="small muted">Reviewer notes</div><ul className="issues">{r.notes.map((c, i) => <li key={i}>{c}</li>)}</ul></div>)}

      {task.summary && (
        <details open>
          <summary className="small muted">Author summary</summary>
          <Markdown text={task.summary} />
        </details>
      )}
      {task.testStatus === 'fail' && task.testOutput && (
        <details><summary className="small badge-fail">Test output (tail)</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{task.testOutput}</pre></details>
      )}

      <div>
        <div className="spread"><span className="small muted">Diff {task.branch && <span className="chip mono">{task.branch}</span>}</span><button className="sm ghost" onClick={() => setShowDiff((s) => !s)}>{showDiff ? 'Hide' : 'Show'}</button></div>
        {showDiff && (diff ? <DiffView diff={diff.diff} truncated={diff.truncated} /> : <div className="small dim">Loading diff…</div>)}
      </div>

      {problem && (
        <div className="banner bad">
          {problem.message}
          {problem.conflicts && problem.conflicts.length > 0 && <div className="small mono">Conflicts: {problem.conflicts.join(', ')}</div>}
          {problem.files && problem.files.length > 0 && <div className="small mono">{problem.files.slice(0, 10).join('\n')}</div>}
          {problem.conflicts && <div style={{ marginTop: 6 }}><button className="sm" disabled={busy} onClick={rebase}>Rebase onto current branch</button></div>}
        </div>
      )}

      {task.status === 'awaiting_approval' && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={approve}>✔ Approve &amp; merge</button>
          <button className="danger" disabled={busy} onClick={() => setDialog('reject')}>Reject…</button>
          <button disabled={busy} onClick={() => setDialog('retry')}>Retry with feedback…</button>
          <button disabled={busy} onClick={() => setDialog('reassign')}>Reassign…</button>
        </div>
      )}
      {dialog && <RetryDialog task={task} mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
