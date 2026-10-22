import type { Db } from './db.js';
import type { AgentEvent, ProviderStatus, Run, StoredEvent, Task, WsServerMessage } from './types.js';

const MAX_TEXT = 20 * 1024;
const MAX_OUTPUT = 100 * 1024;

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

/** Cap event sizes before they hit the DB / WS (§6.2). */
export function clampEvent(e: AgentEvent): AgentEvent {
  const out: AgentEvent = { kind: e.kind };
  if (e.text !== undefined) out.text = truncate(String(e.text), MAX_TEXT);
  if (e.data !== undefined) {
    let data = e.data;
    if (typeof data.output === 'string' && data.output.length > MAX_OUTPUT) {
      data = { ...data, output: truncate(data.output, MAX_OUTPUT) };
    }
    // Guard against huge raw payloads (unknown native events are stored under data.raw).
    const s = JSON.stringify(data);
    if (s.length > MAX_OUTPUT + MAX_TEXT) data = { truncated: true, preview: s.slice(0, MAX_TEXT) };
    out.data = data;
  }
  return out;
}

type Listener = (msg: WsServerMessage) => void;

export class Bus {
  private listeners = new Set<Listener>();
  /** Set by the engine; used to build absolute links in push notifications. */
  ntfyTopic: () => string | null = () => null;
  publicUrl: () => string | null = () => null;

  constructor(private db: Db) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(msg: WsServerMessage) {
    for (const fn of this.listeners) {
      try { fn(msg); } catch { /* a broken socket must not break the pipeline */ }
    }
  }

  /** Persist an event and broadcast it. */
  emit(runId: string, taskId: string | null, provider: string | null, e: AgentEvent): StoredEvent {
    const stored = this.db.insertEvent(runId, taskId, provider, clampEvent(e));
    this.broadcast({ type: 'event', event: stored });
    return stored;
  }

  task(t: Task | null) { if (t) this.broadcast({ type: 'task', task: t }); }
  run(r: Run | null) { if (r) this.broadcast({ type: 'run', run: r }); }
  providers(p: ProviderStatus[]) { this.broadcast({ type: 'providers', providers: p }); }

  notify(title: string, body: string, url?: string) {
    this.broadcast({ type: 'notify', title, body, url });
    const topic = this.ntfyTopic();
    if (topic) void sendNtfy(topic, title, body, url ? this.absolute(url) : undefined);
  }

  private absolute(url: string): string | undefined {
    const base = this.publicUrl();
    if (!base) return undefined;
    return base.replace(/\/$/, '') + url;
  }
}

export async function sendNtfy(topic: string, title: string, body: string, click?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = { Title: asciiHeader(title), Tags: 'robot' };
    if (click) headers.Click = click;
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// HTTP header values must be latin1; ntfy also accepts RFC 2047 but plain ASCII is simplest.
function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
