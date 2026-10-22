import { execFile, spawn } from 'node:child_process';
import { truncate } from '../bus.js';
import { detectLimit, type LimitHit } from '../limits.js';
import type { AgentEvent, AgentRole, ProviderId } from '../types.js';

export interface AgentRequest {
  cwd: string;
  prompt: string;
  model: string;               // "" = CLI default
  readOnly: boolean;
  resumeSessionId?: string;
  timeoutMs: number;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /** Hints for the mock adapter / logging. Real CLIs ignore them. */
  role?: AgentRole;
  taskKey?: string;
}

export interface AgentResult {
  ok: boolean;
  finalText: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  limited: null | { resetAt: number | null; message: string };
  error: string | null;
}

export interface Adapter {
  id: ProviderId;
  available(): Promise<{ installed: boolean; version?: string }>;
  run(req: AgentRequest): Promise<AgentResult>;
}

/** Per-run parser state. Parsers are tolerant: they never throw on missing fields. */
export interface StreamParser {
  /** Map one parsed JSON line to zero or more normalized events. */
  feed(obj: any): AgentEvent[];
  /** Called at EOF so parsers that buffer deltas can flush. */
  flush?(): AgentEvent[];
  sessionId: string | null;
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  /** Set by the parser when the CLI reported a structured limit. */
  limited: LimitHit | null;
  /** Set by the parser when the CLI reported an error result. */
  error: string | null;
}

export const PROMPT_ARG_MAX = 100 * 1024;
const STDERR_KEEP = 20 * 1024;

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
}

/**
 * Spawn without a shell, line-buffer both streams, kill the whole process group on timeout/abort
 * (SIGTERM, then SIGKILL after 5 s).
 */
export function runProcess(bin: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stderrTail = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      resolve({ code: null, signal: null, stderrTail: '', timedOut: false, aborted: false, spawnError: (e as Error).message });
      return;
    }

    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, 5000);
      killTimer.unref();
    };

    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, opts.timeoutMs));
    timer.unref();
    const onAbort = () => { aborted = true; kill(); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const lineSplitter = (cb?: (l: string) => void, keep?: (chunk: string) => void) => {
      let buf = '';
      return {
        data(chunk: Buffer) {
          const s = chunk.toString('utf8');
          keep?.(s);
          buf += s;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line.length) cb?.(line);
          }
        },
        end() { if (buf.length) cb?.(buf); buf = ''; },
      };
    };

    const out = lineSplitter(opts.onStdoutLine);
    const err = lineSplitter(opts.onStderrLine, (s) => {
      stderrTail += s;
      if (stderrTail.length > STDERR_KEEP) stderrTail = stderrTail.slice(-STDERR_KEEP);
    });
    child.stdout!.on('data', out.data);
    child.stderr!.on('data', err.data);

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE if the CLI exits early */ });
      child.stdin.end(opts.stdin);
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      out.end();
      err.end();
      resolve({ code, signal, stderrTail, timedOut, aborted, spawnError });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

export function versionOf(bin: string, timeoutMs = 10_000): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ installed: false });
      if (err && !stdout) return resolve({ installed: false });
      const v = (stdout || stderr).trim().split('\n')[0]?.slice(0, 80);
      resolve({ installed: true, version: v || undefined });
    });
  });
}

export interface CliSpec {
  id: ProviderId;
  bin: () => string;
  extraArgs: () => string[];
  /** Build argv incl. the user's extraArgs. `viaStdin` is true when the prompt is too large for argv and will be piped. */
  buildArgs(req: AgentRequest, viaStdin: boolean, extraArgs: string[]): string[];
  makeParser(req: AgentRequest): StreamParser;
  /** Whether this CLI reads the prompt from stdin when not given as an argument. */
  stdinPrompt: boolean;
  /** Wrap the prompt for stdin (default: the raw prompt). */
  stdinPayload?: (prompt: string) => string;
  env?: () => NodeJS.ProcessEnv;
}

/** Generic adapter for JSONL-streaming CLIs. */
export function createCliAdapter(spec: CliSpec): Adapter {
  return {
    id: spec.id,
    available: () => versionOf(spec.bin()),
    async run(req: AgentRequest): Promise<AgentResult> {
      const started = Date.now();
      const parser = spec.makeParser(req);
      let limited: LimitHit | null = null;
      const errors: string[] = [];
      const emit = (e: AgentEvent) => {
        if (e.kind === 'error' && e.text) {
          errors.push(e.text);
          limited ??= detectLimit(e.text);
        }
        if (e.text !== undefined) e = { ...e, text: truncate(e.text, 20 * 1024) };
        try { req.onEvent(e); } catch { /* listener errors must not kill the stream */ }
      };
      const viaStdin = spec.stdinPrompt && Buffer.byteLength(req.prompt) > PROMPT_ARG_MAX;
      const args = spec.buildArgs(req, viaStdin, spec.extraArgs());

      const res = await runProcess(spec.bin(), args, {
        cwd: req.cwd,
        env: spec.env?.() ?? process.env,
        stdin: viaStdin ? (spec.stdinPayload ? spec.stdinPayload(req.prompt) : req.prompt) : undefined,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onStdoutLine(line) {
          for (const ev of parseLine(parser, line)) emit(ev);
        },
        onStderrLine(line) {
          emit({ kind: 'log', text: line, data: { stream: 'stderr' } });
          limited ??= detectLimit(line);
        },
      });
      for (const ev of parser.flush?.() ?? []) emit(ev);

      let error: string | null = null;
      if (res.spawnError) error = `failed to start ${spec.bin()}: ${res.spawnError}`;
      else if (res.aborted) error = 'stopped by user';
      else if (res.timedOut) error = `timed out after ${Math.round(req.timeoutMs / 60000)} min`;
      else if (parser.error) error = parser.error;
      else if (res.code !== 0) error = `${spec.id} exited with code ${res.code}${res.signal ? ` (${res.signal})` : ''}: ${lastLines(res.stderrTail || errors.join('\n'), 5)}`;
      else if (parser.limited) error = parser.limited.message;

      // A limit only counts when the run did not succeed — CLIs often log transient 429 retries on stderr.
      if (!error || res.aborted || res.spawnError) limited = null;
      else limited = parser.limited ?? limited ?? detectLimit(error) ?? detectLimit(res.stderrTail);

      return {
        ok: !error && !limited,
        finalText: parser.finalText,
        sessionId: parser.sessionId,
        inputTokens: parser.inputTokens,
        outputTokens: parser.outputTokens,
        durationMs: Date.now() - started,
        limited,
        error: error ?? (limited ? limited.message : null),
      };
    },
  };
}

/** Parse one stdout line: JSON → parser events; anything else → a `log` event. Never throws. */
export function parseLine(parser: StreamParser, line: string): AgentEvent[] {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return [{ kind: 'log', text: line }]; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return [{ kind: 'log', text: line }];
  try { return parser.feed(obj); } catch (e) {
    return [{ kind: 'log', text: `parser error: ${(e as Error).message}`, data: { raw: obj as Record<string, unknown> } }];
  }
}

function lastLines(s: string, n: number): string {
  return s.trim().split('\n').slice(-n).join('\n').slice(0, 2000);
}

// ---- helpers shared by parsers ---------------------------------------------------------------

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** First defined value among keys. */
export function pick(obj: any, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** Short one-line rendering of tool args for the feed. */
export function shortArgs(input: unknown, max = 160): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input.slice(0, max);
  try {
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return ''; }
}

export function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : str(c?.text) ?? '')).join('');
  if (content && typeof content === 'object') return str((content as any).text) ?? shortArgs(content, 4000);
  return '';
}
