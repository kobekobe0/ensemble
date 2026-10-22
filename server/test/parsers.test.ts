import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityArgs, antigravityStdin, createAntigravityParser } from '../src/adapters/antigravity.js';
import { parseLine, type StreamParser } from '../src/adapters/base.js';
import { claudeArgs, createClaudeParser } from '../src/adapters/claude.js';
import { codexArgs, createCodexParser } from '../src/adapters/codex.js';
import { createGeminiParser, geminiArgs } from '../src/adapters/gemini.js';
import type { AgentEvent } from '../src/types.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function run(parser: StreamParser, file: string): AgentEvent[] {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
  const out = lines.flatMap((l) => parseLine(parser, l));
  return [...out, ...(parser.flush?.() ?? [])];
}
const kinds = (evs: AgentEvent[]) => evs.map((e) => e.kind);

describe('claude parser', () => {
  it('maps the recorded stream-json to normalized events', () => {
    const p = createClaudeParser();
    const evs = run(p, 'claude.jsonl');
    expect(evs[0]).toMatchObject({ kind: 'system' });
    expect(p.sessionId).toBe('1e958432-b43e-4b9a-82cd-3b8d11597c0e');
    expect(evs.find((e) => e.kind === 'tool' && e.data?.name === 'Bash' && (e.data.input as any).command === 'ls -la')).toBeTruthy();
    expect(evs.find((e) => e.kind === 'file_change')).toMatchObject({ text: '/tmp/fixture/a.txt' });
    expect(evs.filter((e) => e.kind === 'command').map((e) => e.text)).toEqual(['ls -la', 'npm test']);
    expect(evs.filter((e) => e.kind === 'tool_result').map((e) => e.text)).toEqual(['a.txt\nerr.txt\nout.jsonl', '1 passing']);
    expect(evs.find((e) => e.kind === 'thinking')?.text).toBe('I should edit the file.');
    expect(evs.find((e) => e.kind === 'log' && e.text === 'this is not json {')).toBeTruthy();
    // quiet system subtypes are dropped; no events for commands_changed
    expect(evs.some((e) => e.text?.includes('commands_changed'))).toBe(false);
    expect(kinds(evs)).toContain('usage');
    expect(p.finalText).toContain('DONE');
    expect(p.outputTokens).toBe(157);
    expect(p.inputTokens).toBe(4 + 15266 + 51808);
    expect(p.error).toBeNull();
    expect(p.limited).toBeNull();
  });

  it('reports structured limits and error results', () => {
    const p = createClaudeParser();
    parseLine(p, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792659600, rateLimitType: 'five_hour' } }));
    parseLine(p, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1792659600', usage: {} }));
    expect(p.error).toContain('usage limit');
    expect(p.limited?.resetAt).toBe(1792659600 * 1000);
  });

  it('never crashes on odd shapes', () => {
    const p = createClaudeParser();
    for (const o of [{}, { type: 'assistant' }, { type: 'assistant', message: { content: 'x' } }, { type: 'user', message: null }, { type: 'result' }, { type: 'system' }]) {
      expect(() => parseLine(p, JSON.stringify(o))).not.toThrow();
    }
    expect(parseLine(p, '[1,2]')).toEqual([{ kind: 'log', text: '[1,2]' }]);
    expect(parseLine(p, JSON.stringify({ type: 'brand_new' }))[0]).toMatchObject({ kind: 'log', data: { raw: { type: 'brand_new' } } });
  });

  it('builds args', () => {
    const base = { cwd: '/x', prompt: 'hi', model: '', timeoutMs: 1, signal: new AbortController().signal, onEvent: () => {} };
    expect(claudeArgs({ ...base, readOnly: true }, false)).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan']);
    expect(claudeArgs({ ...base, model: 'opus', readOnly: false, resumeSessionId: 's1' }, true, ['--allowedTools', 'Bash(npm *)']))
      .toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--resume', 's1', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm *)']);
  });
});

describe('codex parser', () => {
  it('maps exec --json events', () => {
    const p = createCodexParser();
    const evs = run(p, 'codex.jsonl');
    expect(p.sessionId).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(kinds(evs)).toEqual(['system', 'thinking', 'command', 'command', 'file_change', 'file_change', 'tool', 'tool', 'log', 'text', 'usage', 'log']);
    const cmds = evs.filter((e) => e.kind === 'command');
    expect(cmds[0].data).toMatchObject({ status: 'in_progress' });
    expect(cmds[1].data).toMatchObject({ exitCode: 0, output: 'README.md\nsrc\n' });
    expect(evs.filter((e) => e.kind === 'file_change').map((e) => e.text)).toEqual(['src/app.ts', 'src/new.ts']);
    expect(p.finalText).toBe('Updated src/app.ts and added src/new.ts.');
    expect(p.inputTokens).toBe(24763);
    expect(p.outputTokens).toBe(122);
  });

  it('accepts the legacy item_type / assistant_message names', () => {
    const p = createCodexParser();
    const evs = run(p, 'codex-legacy.jsonl');
    expect(evs.find((e) => e.kind === 'text')?.text).toBe('Legacy hello.');
    expect(p.finalText).toBe('Legacy hello.');
  });

  it('surfaces errors so limits can be detected', () => {
    const p = createCodexParser();
    const evs = run(p, 'codex-limit.jsonl');
    expect(evs.filter((e) => e.kind === 'error')).toHaveLength(2);
    expect(p.error).toMatch(/usage limit/);
  });

  it('builds args (prompt last, resume subcommand, stdin dash)', () => {
    const base = { cwd: '/w', prompt: 'do it', model: '', timeoutMs: 1, signal: new AbortController().signal, onEvent: () => {} };
    expect(codexArgs({ ...base, readOnly: true }, false)).toEqual(['exec', '--json', '-C', '/w', '--sandbox', 'read-only', '--skip-git-repo-check', 'do it']);
    expect(codexArgs({ ...base, readOnly: false, model: 'm', resumeSessionId: 'th' }, true, ['--full-auto']))
      .toEqual(['exec', '--json', '-C', '/w', '-m', 'm', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--full-auto', 'resume', 'th', '-']);
  });
});

describe('gemini parser', () => {
  it('maps stream-json events and concatenates deltas', () => {
    const p = createGeminiParser();
    const evs = run(p, 'gemini.jsonl');
    expect(p.sessionId).toBe('c6a9e2a1-5b3e-4a77-9f0e-1b2c3d4e5f60');
    expect(evs.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['I\'ll list the files.', 'DONE']);
    expect(evs.find((e) => e.kind === 'command')?.text).toBe('ls -la');
    expect(evs.find((e) => e.kind === 'file_change')?.text).toBe('/tmp/fixture/b.txt');
    expect(evs.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
    expect(evs.find((e) => e.kind === 'log')?.text).toBe('garbage line');
    expect(p.inputTokens).toBe(1200);
    expect(p.outputTokens).toBe(300);
    expect(p.finalText).toBe('DONE');
    expect(p.error).toBeNull();
  });

  it('records errors', () => {
    const p = createGeminiParser();
    run(p, 'gemini-limit.jsonl');
    expect(p.error).toMatch(/RESOURCE_EXHAUSTED/);
  });

  it('builds args', () => {
    const base = { cwd: '/w', prompt: 'p', model: '', timeoutMs: 1, signal: new AbortController().signal, onEvent: () => {} };
    expect(geminiArgs({ ...base, readOnly: false }, false)).toEqual(['-p', 'p', '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust']);
    expect(geminiArgs({ ...base, readOnly: true, model: 'gemini-2.5-flash', resumeSessionId: 'abc' }, false)).toEqual(['-p', 'p', '--output-format', 'stream-json', '-m', 'gemini-2.5-flash', '--approval-mode', 'plan', '--skip-trust', '--resume', 'abc']);
  });
});

describe('antigravity parser (real agy 1.4.5 captures)', () => {
  it('maps a work turn: tool + file_change inside cwd, text, usage', () => {
    const p = createAntigravityParser('/tmp/fixture');
    const evs = run(p, 'antigravity-work.jsonl');
    expect(evs[0].kind).toBe('system');
    expect(p.sessionId).toBe('c4f00fb0-4747-4e05-84d2-c9a351db0f78');
    expect(evs.filter((e) => e.kind === 'tool')).toHaveLength(1); // ACTIVE + DONE → one tool event
    expect(evs.find((e) => e.kind === 'file_change')?.text).toBe('greeting.txt');
    expect(evs.find((e) => e.kind === 'tool_result')).toBeTruthy();
    expect(evs.find((e) => e.kind === 'log')?.text).toBe('not json {');
    expect(p.finalText).toBe('DONE');
    expect(p.inputTokens).toBeGreaterThan(0);
    expect(p.error).toBeNull();
    expect(p.denied).toBe(false);
  });

  it('joins text deltas per step and ignores writes outside the workspace', () => {
    const p = createAntigravityParser('/tmp/fixture');
    const evs = run(p, 'antigravity-plan.jsonl');
    const texts = evs.filter((e) => e.kind === 'text').map((e) => e.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^I have created the implementation plan in \[implementation_plan\.md\]/);
    expect(evs.some((e) => e.kind === 'file_change')).toBe(false); // plan file lives in ~/.gemini/antigravity-cli/brain
    expect(evs.some((e) => e.kind === 'tool' && e.data?.name === 'write_file')).toBe(true);
  });

  it('flags permission denials and empty replies', () => {
    const p = createAntigravityParser('/tmp/fixture');
    const evs = run(p, 'antigravity-denied.jsonl');
    expect(evs.find((e) => e.kind === 'command')?.text).toBe('ls -la');
    expect(evs.find((e) => e.kind === 'tool_result')?.data?.isError).toBe(true);
    expect(p.denied).toBe(true);
    expect(p.finalText).toBe('');
  });

  it('reports non-success results as errors', () => {
    const p = createAntigravityParser();
    parseLine(p, JSON.stringify({ event: 'result', result: { conversation_id: 'x', status: 'ERROR', error: { message: 'RESOURCE_EXHAUSTED: quota exceeded, retry in 3 hours' }, usage: {} } }));
    expect(p.error).toMatch(/RESOURCE_EXHAUSTED/);
  });

  it('builds args with -p=<prompt> last and stdin mode', () => {
    const base = { cwd: '/w', prompt: '-starts with dash', model: '', timeoutMs: 1, signal: new AbortController().signal, onEvent: () => {} };
    expect(antigravityArgs({ ...base, readOnly: true }, false)).toEqual(['--output-format', 'stream-json', '--mode', 'plan', '-p=-starts with dash']);
    expect(antigravityArgs({ ...base, readOnly: false, model: 'gemini-3.8-flash-high', resumeSessionId: 'c1' }, true, ['--sandbox']))
      .toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'gemini-3.8-flash-high', '--conversation', 'c1', '--sandbox', '-p=']);
    expect(JSON.parse(antigravityStdin('hi'))).toEqual({ event: 'user', message: { content: 'hi' } });
  });
});
