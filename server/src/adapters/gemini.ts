// Gemini CLI adapter (§6.5).
// Verified against gemini 0.65 (`gemini --help` + bundled source):
//   gemini -p <prompt> --output-format stream-json [-m <model>] --approval-mode <auto_edit|plan> --skip-trust [--resume <uuid>]
// - `plan` is Gemini's read-only approval mode (used for planning/review).
// - Headless runs abort in folders Gemini hasn't trusted, and every task worktree is a new folder, so
//   `--skip-trust` trusts the folder for this invocation only (nothing is persisted).
// - `--resume` accepts "latest", an index, or a full session UUID; sessions are stored per working directory.
// Event field names are not fully documented, so the parser accepts several spellings.
// Gemini reads stdin and combines it with -p, so large prompts are piped with a short -p instruction.
import type { AgentEvent } from '../types.js';
import { createCliAdapter, num, pick, shortArgs, str, toText, type AgentRequest, type StreamParser } from './base.js';

const FILE_TOOLS = /^(write_file|replace|edit|edit_file|write|create_file|smart_edit|apply_patch)$/i;
const SHELL_TOOLS = /^(run_shell_command|shell|bash|run_command)$/i;

export function geminiArgs(req: AgentRequest, viaStdin: boolean, extraArgs: string[] = []): string[] {
  const args = ['-p', viaStdin ? 'Follow the instructions provided on stdin.' : req.prompt, '--output-format', 'stream-json'];
  if (req.model) args.push('-m', req.model);
  args.push('--approval-mode', req.readOnly ? 'plan' : 'auto_edit', '--skip-trust');
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  return [...args, ...extraArgs];
}

/** BFS for the first numeric field whose key matches `re`. */
function findNumber(obj: unknown, re: RegExp, depth = 0): number | null {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const queue: unknown[] = [obj];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (typeof v === 'number' && re.test(k)) return v;
    }
    for (const v of Object.values(cur as Record<string, unknown>)) if (v && typeof v === 'object') queue.push(v);
  }
  return null;
}

export function createGeminiParser(): StreamParser {
  let buf = '';
  const flushText = (): AgentEvent[] => {
    if (!buf) return [];
    const text = buf;
    buf = '';
    p.finalText = text;
    return [{ kind: 'text', text }];
  };
  const toolNames = new Map<string, string>();

  const p: StreamParser = {
    sessionId: null, finalText: '', inputTokens: 0, outputTokens: 0, limited: null, error: null,
    feed(o: any): AgentEvent[] {
      const type = str(o?.type) ?? str(o?.event);
      const sid = str(pick(o, 'session_id', 'sessionId'));
      if (sid) p.sessionId = sid;
      if (type === 'message') {
        const role = str(o.role) ?? 'assistant';
        if (role !== 'assistant' && role !== 'model') return flushText();
        const chunk = toText(pick(o, 'content', 'text', 'delta'));
        if (o.delta === true || o.delta === undefined) { buf += chunk; return []; }
        buf += chunk;
        return flushText();
      }
      const out = flushText();
      switch (type) {
        case 'init':
          out.push({ kind: 'system', text: `session ${p.sessionId ?? '?'} · model ${pick(o, 'model') ?? 'default'}`, data: { sessionId: p.sessionId, model: pick(o, 'model') } });
          break;
        case 'thought':
        case 'thinking': {
          const t = toText(pick(o, 'content', 'text', 'subject'));
          if (t) out.push({ kind: 'thinking', text: t });
          break;
        }
        case 'tool_use':
        case 'tool_call': {
          const name = str(pick(o, 'tool_name', 'name', 'tool')) ?? 'tool';
          const id = str(pick(o, 'tool_id', 'id', 'call_id'));
          if (id) toolNames.set(id, name);
          const params: any = pick(o, 'parameters', 'args', 'input', 'arguments') ?? {};
          out.push({ kind: 'tool', text: `${name} ${shortArgs(params)}`.trim(), data: { name, id, input: params } });
          if (FILE_TOOLS.test(name)) {
            const path = str(pick(params, 'file_path', 'path', 'absolute_path', 'filePath'));
            out.push({ kind: 'file_change', text: path ?? name, data: { path, tool: name } });
          } else if (SHELL_TOOLS.test(name)) {
            const command = str(pick(params, 'command', 'cmd')) ?? '';
            out.push({ kind: 'command', text: command, data: { command, status: 'started' } });
          }
          break;
        }
        case 'tool_result': {
          const id = str(pick(o, 'tool_id', 'id', 'call_id'));
          const status = str(o.status);
          out.push({
            kind: 'tool_result',
            text: toText(pick(o, 'output', 'result', 'content')) || (status ?? ''),
            data: { toolUseId: id, name: id ? toolNames.get(id) : undefined, status, isError: status === 'error' || !!o.error },
          });
          break;
        }
        case 'error': {
          const msg = str(pick(o, 'message', 'error')) ?? toText(o.error) ?? 'error';
          const fatal = o.severity ? o.severity === 'error' : true;
          if (fatal) p.error = msg;
          out.push({ kind: 'error', text: msg });
          break;
        }
        case 'result': {
          const stats = o.stats ?? o.usage ?? {};
          p.inputTokens += num(findNumber(stats, /^(input_tokens|inputTokens|input|prompt_tokens|promptTokens|promptTokenCount)$/));
          p.outputTokens += num(findNumber(stats, /^(output_tokens|outputTokens|output|candidates_tokens|candidatesTokenCount)$/));
          const result = str(pick(o, 'result', 'response'));
          if (result) p.finalText = result;
          out.push({ kind: 'usage', text: `in ${p.inputTokens} · out ${p.outputTokens}`, data: { inputTokens: p.inputTokens, outputTokens: p.outputTokens, stats } });
          const status = str(o.status);
          if (status && status !== 'success' && status !== 'ok') {
            const msg = str(pick(o, 'error', 'message')) ?? toText(o.error) ?? `Gemini finished with status ${status}`;
            p.error = msg;
            out.push({ kind: 'error', text: msg });
          }
          break;
        }
        default:
          out.push({ kind: 'log', text: `unknown event ${type ?? '?'}`, data: { raw: o } });
      }
      return out;
    },
    flush: () => flushText(),
  };
  return p;
}

export function createGeminiAdapter(bin: () => string, extraArgs: () => string[]) {
  return createCliAdapter({
    id: 'gemini', bin, extraArgs, stdinPrompt: true,
    buildArgs: geminiArgs,
    makeParser: createGeminiParser,
  });
}
