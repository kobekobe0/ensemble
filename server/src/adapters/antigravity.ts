// Antigravity CLI (`agy`) adapter — Google's replacement for Gemini CLI on personal accounts
// (Gemini CLI stopped serving Google AI Pro/Ultra/free accounts on 2026-06-18).
// Verified against agy 1.4.5 by capturing real stream-json output (see test/fixtures/antigravity*.jsonl):
//   agy -p=<prompt> --output-format stream-json --mode <accept-edits|plan> [--model <slug>] [--conversation <id>]
//   large prompts: agy --input-format stream-json --output-format stream-json ... -p=   (one NDJSON user message on stdin)
// Events: {event:"init", conversation_id, init:{cwd,tools,permission_mode}}
//         {event:"step_update", step_update:{step_index, state:ACTIVE|DONE|ERROR, step_type, text_delta?, tool_info?, usage?}}
//         {event:"result", result:{conversation_id, status, response, error?, usage, denied_actions?}}
// Headless agy cannot prompt for permissions: shell commands are auto-denied (like Claude's acceptEdits),
// and the model sometimes ends the turn with an empty reply after a denial. The adapter then resumes the
// conversation once with a nudge to use file tools instead.
import path from 'node:path';
import type { AgentEvent } from '../types.js';
import { createCliAdapter, num, pick, shortArgs, str, toText, type Adapter, type AgentRequest, type AgentResult, type StreamParser } from './base.js';

const FILE_TOOLS = /^(write_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|edit_file|create_file)$/i;
const SHELL_TOOLS = /^(run_command|command|shell|send_command_input)$/i;

const READONLY_HINT = 'Session note: you are in read-only mode and shell commands are unavailable. The files you need are named below; open them with read_file using paths relative to the current directory. Answer directly in your reply — do not write a plan document or ask for approval.\n\n';
const WORK_HINT = 'Session note: shell commands may be denied in this session; if a command is denied, continue using the file tools (view/read, write, replace) instead of stopping.\n\n';
export const NUDGE_PROMPT = 'Running shell commands was denied and is not possible in this session. Do not try run_command again. Use the file tools to inspect or edit files, then finish the task and give your answer in the format I asked for.';

export function antigravityArgs(req: AgentRequest, viaStdin: boolean, extraArgs: string[] = []): string[] {
  const args: string[] = [];
  if (viaStdin) args.push('--input-format', 'stream-json');
  args.push('--output-format', 'stream-json', '--mode', req.readOnly ? 'plan' : 'accept-edits');
  if (req.model) args.push('--model', req.model);
  if (req.resumeSessionId) args.push('--conversation', req.resumeSessionId);
  args.push(...extraArgs);
  // `-p=<value>` so a prompt starting with "-" is never mistaken for a flag; it goes last for the same reason.
  args.push(`-p=${viaStdin ? '' : req.prompt}`);
  return args;
}

/** stdin payload for --input-format stream-json */
export function antigravityStdin(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
}

export function createAntigravityParser(cwd = ''): StreamParser & { denied: boolean } {
  const textBuf = new Map<number, string>();
  const toolSeen = new Set<number>();
  const flushText = (idx: number): AgentEvent[] => {
    const t = textBuf.get(idx);
    textBuf.delete(idx);
    return t && t.trim() ? [{ kind: 'text', text: t.replace(/\n$/, '') }] : [];
  };
  const insideCwd = (p: string | undefined) => {
    if (!p || !cwd) return !!p;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    const rel = path.relative(cwd, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  const p: StreamParser & { denied: boolean } = {
    sessionId: null, finalText: '', inputTokens: 0, outputTokens: 0, limited: null, error: null, denied: false,
    feed(o: any): AgentEvent[] {
      const ev = str(o?.event) ?? str(o?.type);
      const sid = str(o?.conversation_id) ?? str(o?.step_update?.conversation_id) ?? str(o?.result?.conversation_id);
      if (sid) p.sessionId = sid;
      switch (ev) {
        case 'init': {
          const init = o.init ?? {};
          return [{ kind: 'system', text: `conversation ${p.sessionId ?? '?'} · ${init.permission_mode ?? 'default'} permissions`, data: { sessionId: p.sessionId, permissionMode: init.permission_mode, cwd: init.cwd } }];
        }
        case 'step_update': {
          const s = o.step_update ?? {};
          const idx = num(s.step_index);
          const type = str(s.step_type) ?? 'unknown';
          const state = str(s.state) ?? '';
          if (type === 'agent_response') {
            if (str(s.text_delta)) textBuf.set(idx, (textBuf.get(idx) ?? '') + s.text_delta);
            const thinking = str(s.thinking_delta) ?? str(s.thinking);
            const out: AgentEvent[] = thinking ? [{ kind: 'thinking', text: thinking }] : [];
            if (state !== 'ACTIVE') out.push(...flushText(idx));
            return out;
          }
          if (type === 'thinking' || type === 'reasoning') {
            const t = str(s.text_delta) ?? str(s.thinking_delta) ?? '';
            return t ? [{ kind: 'thinking', text: t }] : [];
          }
          if (type === 'tool') {
            const info = s.tool_info ?? {};
            const name = str(info.name) ?? str(s.tool_name) ?? 'tool';
            const params = info.parameters ?? info.args ?? {};
            const out: AgentEvent[] = [];
            if (!toolSeen.has(idx)) {
              toolSeen.add(idx);
              out.push({ kind: 'tool', text: `${name} ${shortArgs(params)}`.trim(), data: { name, id: idx, input: params } });
              const file = str(pick(params, 'Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'path', 'file_path'));
              if (FILE_TOOLS.test(name) && insideCwd(file)) {
                const shown = file && cwd && path.isAbsolute(file) ? path.relative(cwd, file) : file;
                out.push({ kind: 'file_change', text: shown ?? name, data: { path: shown, tool: name } });
              } else if (SHELL_TOOLS.test(name)) {
                const command = str(pick(params, 'CommandLine', 'command', 'Command')) ?? '';
                out.push({ kind: 'command', text: command, data: { command, status: 'started' } });
              }
            }
            if (state === 'DONE' || state === 'ERROR') {
              const err = info.error;
              const msg = err ? (str(err.message) ?? toText(err)) : '';
              if (msg && /permission check failed|denied permission/i.test(msg)) p.denied = true;
              const output = toText(pick(info, 'output', 'result'));
              out.push({ kind: 'tool_result', text: msg || output || state.toLowerCase(), data: { toolUseId: idx, name, isError: state === 'ERROR' || !!err } });
            }
            return out;
          }
          if (s.subagent_info) return [{ kind: 'log', text: `subagent ${shortArgs(s.subagent_info)}` }];
          if (type === 'user_input' || type === 'system_message') return [];
          return [{ kind: 'log', text: `step ${type} ${state}`.trim(), data: { raw: s } }];
        }
        case 'result': {
          const r = o.result ?? {};
          const out: AgentEvent[] = [];
          for (const idx of [...textBuf.keys()]) out.push(...flushText(idx));
          const u = r.usage ?? {};
          p.inputTokens = num(u.input_tokens) + num(u.cache_read_tokens);
          p.outputTokens = num(u.output_tokens) + num(u.thinking_tokens);
          if (typeof r.response === 'string') p.finalText = r.response.replace(/\n$/, '');
          if (Array.isArray(r.denied_actions) && r.denied_actions.length) p.denied = true;
          out.push({ kind: 'usage', text: `in ${p.inputTokens} · out ${p.outputTokens}`, data: { inputTokens: p.inputTokens, outputTokens: p.outputTokens, durationSeconds: r.duration_seconds, numTurns: r.num_turns, deniedActions: r.denied_actions } });
          const status = str(r.status) ?? 'SUCCESS';
          if (status !== 'SUCCESS') {
            const msg = (r.error && (str(r.error.message) ?? toText(r.error))) || str(r.error) || `Antigravity finished with status ${status}`;
            p.error = msg;
            out.push({ kind: 'error', text: msg });
          }
          return out;
        }
        case 'error': {
          const msg = str(o.message) ?? toText(o.error) ?? 'error';
          p.error = msg;
          return [{ kind: 'error', text: msg }];
        }
        default:
          return [{ kind: 'log', text: `unknown event ${ev ?? '?'}`, data: { raw: o } }];
      }
    },
  };
  return p;
}

export function createAntigravityAdapter(bin: () => string, extraArgs: () => string[]): Adapter {
  // Parsers keyed by request object so concurrent runs never share state.
  const parsers = new WeakMap<AgentRequest, ReturnType<typeof createAntigravityParser>>();
  const inner = createCliAdapter({
    id: 'gemini', bin, extraArgs, stdinPrompt: true,
    buildArgs: antigravityArgs,
    stdinPayload: antigravityStdin,
    makeParser: (req) => {
      const parser = createAntigravityParser(req.cwd);
      parsers.set(req, parser);
      return parser;
    },
  });
  return {
    id: 'gemini',
    available: inner.available,
    async run(req: AgentRequest): Promise<AgentResult> {
      const hinted = { ...req, prompt: (req.readOnly ? READONLY_HINT : WORK_HINT) + req.prompt };
      const first = await inner.run(hinted);
      const denied = parsers.get(hinted)?.denied ?? false;
      // Empty reply after a permission denial → one nudge in the same conversation.
      if (first.ok && !first.finalText.trim() && denied && first.sessionId && !req.signal.aborted) {
        req.onEvent({ kind: 'status', text: 'Antigravity stopped after a denied shell command — asking it to continue with file tools' });
        const second = await inner.run({ ...req, prompt: NUDGE_PROMPT, resumeSessionId: first.sessionId });
        return {
          ...second,
          inputTokens: first.inputTokens + second.inputTokens,
          outputTokens: first.outputTokens + second.outputTokens,
          durationMs: first.durationMs + second.durationMs,
          sessionId: second.sessionId ?? first.sessionId,
        };
      }
      // Planning/review need an answer; a work turn may legitimately end with edits and no message.
      if (first.ok && !first.finalText.trim() && req.readOnly) {
        return { ...first, ok: false, error: 'Antigravity returned an empty reply' };
      }
      return first;
    },
  };
}
