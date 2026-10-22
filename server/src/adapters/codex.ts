// OpenAI Codex CLI adapter (§6.4).
// Verified against codex-cli 0.163 (`codex exec --help`, `codex exec resume --help`):
//   codex exec --json -C <cwd> [-m <model>] --sandbox <workspace-write|read-only> <prompt>
//   codex exec --json -C <cwd> [...] resume <sessionId> <prompt>
// `-` as the prompt makes codex read it from stdin. Run `pnpm smoke` to check the parser against the real CLI.
import type { AgentEvent } from '../types.js';
import { createCliAdapter, num, pick, shortArgs, str, type AgentRequest, type StreamParser } from './base.js';

export function codexArgs(req: AgentRequest, viaStdin: boolean, extraArgs: string[] = []): string[] {
  const args = ['exec', '--json', '-C', req.cwd];
  if (req.model) args.push('-m', req.model);
  args.push('--sandbox', req.readOnly ? 'read-only' : 'workspace-write');
  // Worktrees are git repos, but planning may run in a project that codex considers untrusted.
  args.push('--skip-git-repo-check', ...extraArgs);
  const prompt = viaStdin ? '-' : req.prompt;
  if (req.resumeSessionId) args.push('resume', req.resumeSessionId, prompt);
  else args.push(prompt);
  return args;
}

export function createCodexParser(): StreamParser {
  const p: StreamParser = {
    sessionId: null, finalText: '', inputTokens: 0, outputTokens: 0, limited: null, error: null,
    feed(o: any): AgentEvent[] {
      // Older versions wrapped everything in {id, msg:{type,...}}; unwrap if present.
      if (o && typeof o.msg === 'object' && !o.type) o = o.msg;
      const type = str(o?.type);
      switch (type) {
        case 'thread.started':
          p.sessionId = str(o.thread_id) ?? p.sessionId;
          return [{ kind: 'system', text: `thread ${p.sessionId ?? '?'}`, data: { sessionId: p.sessionId } }];
        case 'turn.started':
          return [];
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          return mapItem(type, o.item ?? {});
        case 'turn.completed': {
          const u = o.usage ?? {};
          p.inputTokens += num(u.input_tokens);
          p.outputTokens += num(u.output_tokens);
          return [{ kind: 'usage', text: `in ${p.inputTokens} · out ${p.outputTokens}`, data: { inputTokens: p.inputTokens, outputTokens: p.outputTokens, cachedInputTokens: num(u.cached_input_tokens) } }];
        }
        case 'turn.failed': {
          const msg = errText(o.error) ?? 'turn failed';
          p.error = msg;
          return [{ kind: 'error', text: msg }];
        }
        case 'error': {
          const msg = str(o.message) ?? errText(o.error) ?? 'error';
          p.error = msg;
          return [{ kind: 'error', text: msg }];
        }
        default:
          return [{ kind: 'log', text: `unknown event ${type ?? '?'}`, data: { raw: o } }];
      }
    },
  };

  function mapItem(phase: string, item: any): AgentEvent[] {
    const itype = str(item.type) ?? str(item.item_type) ?? 'unknown';
    const done = phase === 'item.completed';
    switch (itype) {
      case 'agent_message':
      case 'assistant_message': {
        if (!done) return [];
        const text = str(item.text) ?? '';
        if (text) p.finalText = text;
        return text ? [{ kind: 'text', text }] : [];
      }
      case 'reasoning': {
        if (!done) return [];
        const text = str(item.text) ?? str(item.summary) ?? '';
        return text ? [{ kind: 'thinking', text }] : [];
      }
      case 'command_execution': {
        if (phase === 'item.updated') return [];
        const command = str(item.command) ?? '';
        const data: Record<string, unknown> = { command, status: str(item.status) ?? (done ? 'completed' : 'started'), id: item.id };
        if (done) {
          if (item.exit_code !== undefined) data.exitCode = item.exit_code;
          if (str(item.aggregated_output)) data.output = item.aggregated_output;
        }
        return [{ kind: 'command', text: command, data }];
      }
      case 'file_change': {
        if (!done) return [];
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        if (!changes.length) return [{ kind: 'file_change', text: 'files changed', data: { item } }];
        return changes.map((c) => ({ kind: 'file_change' as const, text: str(c?.path) ?? '?', data: { path: c?.path, change: c?.kind } }));
      }
      case 'mcp_tool_call':
      case 'web_search':
      case 'plan_update':
      case 'todo_list': {
        if (!done) return [];
        const name = itype === 'mcp_tool_call' ? `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` : itype;
        const args = pick(item, 'arguments', 'query', 'items', 'plan');
        return [{ kind: 'tool', text: `${name} ${shortArgs(args)}`.trim(), data: { name, item } }];
      }
      case 'error': {
        if (!done) return [];
        const msg = str(item.message) ?? 'error';
        return [{ kind: 'error', text: msg }];
      }
      default:
        return done ? [{ kind: 'log', text: `item ${itype}`, data: { raw: item } }] : [];
    }
  }

  return p;
}

function errText(e: unknown): string | undefined {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return str((e as any).message) ?? JSON.stringify(e).slice(0, 500);
  return undefined;
}

export function createCodexAdapter(bin: () => string, extraArgs: () => string[]) {
  return createCliAdapter({
    id: 'codex', bin, extraArgs, stdinPrompt: true,
    buildArgs: codexArgs,
    makeParser: createCodexParser,
  });
}
