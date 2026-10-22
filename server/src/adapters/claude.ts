// Claude Code adapter (§6.3). Flags verified against `claude --help` (2.1.x):
//   -p/--print, --output-format stream-json, --verbose, --model, --resume, --permission-mode <acceptEdits|plan|…>.
// With -p and no prompt argument, the prompt is read from stdin.
import { detectLimit } from '../limits.js';
import type { AgentEvent } from '../types.js';
import { createCliAdapter, num, shortArgs, str, toText, type AgentRequest, type StreamParser } from './base.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// High-volume system subtypes that carry nothing useful for the feed.
const QUIET_SYSTEM = new Set(['commands_changed', 'task_summary', 'post_turn_summary', 'hook_started', 'hook_response', 'status']);

export function claudeArgs(req: AgentRequest, viaStdin: boolean, extraArgs: string[] = []): string[] {
  const args = ['-p'];
  if (!viaStdin) args.push(req.prompt);
  args.push('--output-format', 'stream-json', '--verbose');
  if (req.model) args.push('--model', req.model);
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  args.push('--permission-mode', req.readOnly ? 'plan' : 'acceptEdits');
  return [...args, ...extraArgs];
}

export function createClaudeParser(): StreamParser {
  let pendingLimit: { resetAt: number | null; message: string } | null = null;
  const p: StreamParser = {
    sessionId: null, finalText: '', inputTokens: 0, outputTokens: 0, limited: null, error: null,
    feed(o: any): AgentEvent[] {
      const type = str(o?.type);
      if (str(o?.session_id)) p.sessionId = o.session_id;
      switch (type) {
        case 'system': {
          if (o.subtype === 'init') {
            return [{ kind: 'system', text: `session ${o.session_id ?? '?'} · model ${o.model ?? 'default'}`, data: { sessionId: o.session_id, model: o.model, cwd: o.cwd } }];
          }
          if (QUIET_SYSTEM.has(o.subtype)) return [];
          return [{ kind: 'log', text: `system: ${o.subtype ?? 'unknown'}` }];
        }
        case 'assistant': {
          const content = Array.isArray(o?.message?.content) ? o.message.content : [];
          const out: AgentEvent[] = [];
          for (const c of content) {
            if (c?.type === 'text' && str(c.text)) {
              out.push({ kind: 'text', text: c.text });
              p.finalText = c.text;
            } else if (c?.type === 'thinking') {
              if (str(c.thinking)) out.push({ kind: 'thinking', text: c.thinking });
            } else if (c?.type === 'tool_use') {
              const name = str(c.name) ?? 'tool';
              const input = c.input ?? {};
              out.push({ kind: 'tool', text: `${name} ${shortArgs(input)}`.trim(), data: { name, id: c.id, input } });
              if (FILE_TOOLS.has(name) && (str(input.file_path) || str(input.notebook_path))) {
                out.push({ kind: 'file_change', text: input.file_path ?? input.notebook_path, data: { path: input.file_path ?? input.notebook_path, tool: name } });
              } else if (name === 'Bash' && str(input.command)) {
                out.push({ kind: 'command', text: input.command, data: { command: input.command, status: 'started' } });
              }
            }
          }
          return out;
        }
        case 'user': {
          const content = Array.isArray(o?.message?.content) ? o.message.content : [];
          return content
            .filter((c: any) => c?.type === 'tool_result')
            .map((c: any) => ({ kind: 'tool_result' as const, text: toText(c.content), data: { toolUseId: c.tool_use_id, isError: !!c.is_error } }));
        }
        case 'rate_limit_event': {
          const info = o.rate_limit_info ?? {};
          if (info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
            const resetAt = num(info.resetsAt) ? num(info.resetsAt) * 1000 : null;
            pendingLimit = { resetAt, message: `Claude usage limit (${info.rateLimitType ?? 'unknown window'}): ${info.status}` };
            return [{ kind: 'limit', text: pendingLimit.message, data: { resetAt, info } }];
          }
          return [];
        }
        case 'result': {
          const u = o.usage ?? {};
          p.inputTokens += num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
          p.outputTokens += num(u.output_tokens);
          if (typeof o.result === 'string') p.finalText = o.result;
          const out: AgentEvent[] = [{
            kind: 'usage',
            text: `in ${p.inputTokens} · out ${p.outputTokens}${o.total_cost_usd ? ` · $${Number(o.total_cost_usd).toFixed(4)}` : ''}`,
            data: { inputTokens: p.inputTokens, outputTokens: p.outputTokens, durationMs: o.duration_ms, numTurns: o.num_turns, subtype: o.subtype },
          }];
          if (o.is_error || (o.subtype && o.subtype !== 'success')) {
            const msg = str(o.result) || str(o.error) || `Claude finished with ${o.subtype ?? 'error'}${o.api_error_status ? ` (HTTP ${o.api_error_status})` : ''}`;
            p.error = msg;
            p.limited = pendingLimit ?? detectLimit(msg) ?? (o.api_error_status === 429 ? { resetAt: null, message: msg } : null);
            out.push({ kind: 'error', text: msg });
          } else {
            p.limited = null;
          }
          return out;
        }
        case 'stream_event':
          return []; // partial deltas (only with --include-partial-messages)
        default:
          return [{ kind: 'log', text: `unknown event ${type ?? '?'}`, data: { raw: o } }];
      }
    },
    flush() {
      if (pendingLimit && !p.error && !p.finalText) { p.limited = pendingLimit; p.error = pendingLimit.message; }
      return [];
    },
  };
  return p;
}

export function createClaudeAdapter(bin: () => string, extraArgs: () => string[]) {
  return createCliAdapter({
    id: 'claude', bin, extraArgs, stdinPrompt: true,
    buildArgs: claudeArgs,
    makeParser: createClaudeParser,
  });
}
