// Phase 6 smoke test against the REAL installed CLIs (uses a little of your quota).
//   pnpm smoke                # every installed + enabled provider
//   pnpm smoke claude gemini  # only these (gemini = Antigravity `agy` by default)
// Runs a tiny read-only prompt in a temp folder and prints the normalized events, so parsers can be
// checked (and fixed) against the CLI versions actually installed on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdapterRegistry } from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import type { AgentEvent, RealProviderId } from '../src/types.js';
import { REAL_PROVIDERS } from '../src/types.js';

const PROMPT = 'Read the files hello.txt and notes.md in the current directory, tell me in one sentence what they contain, then reply DONE';
const wanted = process.argv.slice(2).filter((a) => REAL_PROVIDERS.includes(a as RealProviderId)) as RealProviderId[];
const cfg = loadConfig();
const registry = new AdapterRegistry(() => cfg, false);
await registry.refresh();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-smoke-'));
fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');

const color = (c: number, s: string) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
let failures = 0;

for (const id of wanted.length ? wanted : REAL_PROVIDERS) {
  const av = registry.availability(id);
  console.log(color(1, `\n━━ ${id} ━━ ${av.installed ? av.version ?? 'installed' : 'not installed'} (${registry.binFor(id)})`));
  if (!av.installed) { console.log('  skipped'); continue; }
  if (!cfg.providers[id].enabled) { console.log('  disabled in config — running anyway'); }
  const counts: Record<string, number> = {};
  const res = await registry.get(id).run({
    cwd: dir, prompt: PROMPT, model: '', readOnly: true, timeoutMs: 5 * 60_000, signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      const text = (e.text ?? '').replace(/\s+/g, ' ').slice(0, 140);
      const raw = e.kind === 'log' && e.data?.raw ? ` raw=${JSON.stringify(e.data.raw).slice(0, 200)}` : '';
      console.log(`  ${color(e.kind === 'error' ? 31 : e.kind === 'log' ? 2 : 36, e.kind.padEnd(11))} ${text}${raw}`);
    },
  });
  const ok = res.ok && /DONE/i.test(res.finalText);
  if (!ok) failures++;
  console.log(color(ok ? 32 : 31, `  → ok=${res.ok} session=${res.sessionId ?? '∅'} tokens in/out=${res.inputTokens}/${res.outputTokens} ${res.durationMs}ms`));
  console.log(`  → finalText: ${JSON.stringify(res.finalText.slice(0, 200))}`);
  if (res.error) console.log(color(31, `  → error: ${res.error}`));
  if (res.limited) console.log(color(33, `  → limited: ${res.limited.message} (reset ${res.limited.resetAt ? new Date(res.limited.resetAt).toLocaleString() : 'unknown'})`));
  console.log(`  → event counts: ${JSON.stringify(counts)}`);
  if (counts.log && !counts.text) console.log(color(33, '  ! Only log events: the CLI\'s output format probably changed — update the parser for this provider.'));
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
