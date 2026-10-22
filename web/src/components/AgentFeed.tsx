import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { StoredEvent, Task } from '../types';
import { ACTIVE, fmtClock, fmtDuration, useNow } from '../util';
import { Markdown } from './Markdown';
import { ProviderBadge, StatusChip } from './ProviderBadge';

const MAX_RENDER = 600;

export const EventView = memo(function EventView({ e }: { e: StoredEvent }) {
  const d = (e.data ?? {}) as Record<string, any>;
  const ts = <span className="ts">{fmtClock(e.ts)}</span>;
  let body: ReactNode;
  switch (e.kind) {
    case 'text':
      body = <Markdown text={e.text ?? ''} />;
      break;
    case 'thinking':
      body = (
        <details>
          <summary>thinking · {(e.text ?? '').slice(0, 80).replace(/\s+/g, ' ')}{(e.text?.length ?? 0) > 80 ? '…' : ''}</summary>
          <div style={{ whiteSpace: 'pre-wrap' }}>{e.text}</div>
        </details>
      );
      break;
    case 'tool': {
      const name = d.name ?? (e.text ?? '').split(' ')[0];
      const rest = (e.text ?? '').slice(String(name).length).trim();
      body = <span>🔧 <span className="name">{name}</span> <span className="dim">{rest.slice(0, 200)}</span></span>;
      break;
    }
    case 'tool_result':
      body = (
        <details>
          <summary className={d.isError ? 'badge-fail' : ''}>↳ result{d.isError ? ' (error)' : ''} · {(e.text ?? '').split('\n')[0].slice(0, 80)}</summary>
          <pre>{e.text}</pre>
        </details>
      );
      break;
    case 'command': {
      const done = d.status === 'completed' || d.exitCode !== undefined;
      const exit = d.exitCode;
      body = (
        <div>
          <span className="cmd">{d.command ?? e.text}</span>{' '}
          {d.label && <span className="chip">{d.label}</span>}{' '}
          {done && exit !== undefined && exit !== null && <span className={exit === 0 ? 'badge-pass' : 'badge-fail'}>exit {String(exit)}</span>}
          {!done && <span className="dim">running…</span>}
          {d.output && <details><summary>output ({String(d.output).split('\n').length} lines)</summary><pre>{d.output}</pre></details>}
        </div>
      );
      break;
    }
    case 'file_change':
      body = <span>✎ <span className="chip">{e.text}</span></span>;
      break;
    case 'test':
      body = (
        <div>
          <span className={d.status === 'pass' ? 'badge-pass' : d.status === 'fail' ? 'badge-fail' : 'dim'}>{d.status === 'pass' ? '✔' : d.status === 'fail' ? '✘' : '–'} {e.text}</span>
          {d.output && <details><summary>test output</summary><pre>{d.output}</pre></details>}
        </div>
      );
      break;
    case 'review':
      body = (
        <div>
          <span className={d.verdict === 'approve' ? 'badge-pass' : 'badge-fail'}>⚖ {e.text}</span>
          {Array.isArray(d.critical) && d.critical.length > 0 && <ul className="issues critical">{d.critical.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
          {Array.isArray(d.notes) && d.notes.length > 0 && <ul className="issues">{d.notes.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
        </div>
      );
      break;
    case 'limit':
      body = <span>⚠ {e.text}</span>;
      break;
    case 'error':
      body = <span>✘ {e.text}</span>;
      break;
    case 'usage':
      body = <span className="dim">Σ {e.text}</span>;
      break;
    case 'system':
      body = <span className="dim">● {e.text}</span>;
      break;
    case 'status':
      body = <span>→ {e.text}</span>;
      break;
    default:
      body = <span>{e.text ?? (e.data ? JSON.stringify(e.data).slice(0, 300) : '')}</span>;
  }
  return <div className={`ev k-${e.kind}`}>{ts}{e.provider && e.kind === 'system' ? <ProviderBadge provider={e.provider} /> : null} {body}</div>;
});

export function FeedBody({ events, showLogs }: { events: StoredEvent[]; showLogs: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [limit, setLimit] = useState(MAX_RENDER);
  const shown = (showLogs ? events : events.filter((e) => e.kind !== 'log' || e.data?.warning)).slice(-limit);
  const hiddenCount = (showLogs ? events.length : events.filter((e) => e.kind !== 'log' || e.data?.warning).length) - shown.length;

  useLayoutEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown.length, stick]);

  return (
    <>
      <div
        className="feed-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {hiddenCount > 0 && <button className="sm ghost" onClick={() => setLimit((l) => l + MAX_RENDER)}>Show {Math.min(hiddenCount, MAX_RENDER)} earlier events</button>}
        {shown.map((e) => <EventView key={e.id} e={e} />)}
        {!shown.length && <div className="dim">Waiting for events…</div>}
      </div>
      {!stick && (
        <div style={{ position: 'relative' }}>
          <button className="sm" style={{ position: 'absolute', right: 10, bottom: 8 }} onClick={() => setStick(true)}>↓ Resume auto-scroll</button>
        </div>
      )}
    </>
  );
}

export function AgentFeed({ task, events, title, tall, extra }: { task?: Task; events: StoredEvent[]; title?: ReactNode; tall?: boolean; extra?: ReactNode }) {
  const [showLogs, setShowLogs] = useState(false);
  const running = !!task && ACTIVE.includes(task.status);
  const now = useNow(1000, running);
  const elapsed = task?.startedAt ? (task.finishedAt ?? (running ? now : null) ?? now) - task.startedAt : null;
  useEffect(() => {}, []);
  return (
    <div className={`feed ${tall ? 'tall' : ''}`}>
      <div className="feed-head">
        {task ? (
          <>
            <strong className="mono">{task.key}</strong>
            <span className="grow ellipsis" title={task.title}>{task.title}</span>
            <ProviderBadge provider={task.provider} model={task.model} />
            <StatusChip status={task.status} />
          </>
        ) : (
          <span className="grow">{title}</span>
        )}
      </div>
      <FeedBody events={events} showLogs={showLogs} />
      <div className="feed-foot">
        <span>{elapsed !== null && task?.startedAt ? `⏱ ${fmtDuration(elapsed)}` : ''}{task && task.handoffs > 0 ? ` · ${task.handoffs} handoff${task.handoffs > 1 ? 's' : ''}` : ''}{task && task.attempts > 0 ? ` · ${task.attempts} test fix${task.attempts > 1 ? 'es' : ''}` : ''}</span>
        <span className="row">{extra}<label className="check small"><input type="checkbox" checked={showLogs} onChange={(e) => setShowLogs(e.target.checked)} /> logs</label></span>
      </div>
    </div>
  );
}
