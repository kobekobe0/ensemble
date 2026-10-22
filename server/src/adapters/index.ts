import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, RealProviderId } from '../types.js';
import { REAL_PROVIDERS } from '../types.js';
import type { Adapter } from './base.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createAntigravityAdapter } from './antigravity.js';
import { createGeminiAdapter } from './gemini.js';
import { createMockAdapter } from './mock.js';

export type { Adapter, AgentRequest, AgentResult } from './base.js';

export interface Availability { installed: boolean; version: string | null; checkedAt: number }

/** Resolve a bin that isn't on PATH via the user's login shell (GUI/launchd PATH is minimal on macOS, §15). */
export function resolveViaLoginShell(bin: string): Promise<string | null> {
  if (path.isAbsolute(bin) || !/^[A-Za-z0-9._-]+$/.test(bin)) return Promise.resolve(null);
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    // `bin` is validated above to a plain command name, so it is safe inside the -c string.
    execFile(shell, ['-lc', `command -v ${bin}`], { timeout: 10_000 }, (err, stdout) => {
      const p = stdout?.trim().split('\n').pop();
      resolve(!err && p && path.isAbsolute(p) ? p : null);
    });
  });
}

/** Common install locations that a GUI/launchd PATH (and `zsh -lc`, which skips .zshrc) may miss. */
function resolveFromCommonDirs(bin: string): string | null {
  if (path.isAbsolute(bin) || !/^[A-Za-z0-9._-]+$/.test(bin)) return null;
  const home = os.homedir();
  for (const dir of [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, 'bin'), path.join(home, '.npm-global/bin')]) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export class AdapterRegistry {
  private adapters = new Map<RealProviderId, Adapter>();
  private avail = new Map<RealProviderId, Availability>();
  /** bin name → absolute path discovered via the login shell / common dirs */
  private resolved = new Map<string, string>();

  constructor(private cfg: () => Config, readonly demo: boolean, overrides?: Partial<Record<RealProviderId, Adapter>>) {
    for (const id of REAL_PROVIDERS) {
      const bin = () => this.binFor(id);
      const extra = () => this.cfg().providers[id].extraArgs;
      let a: Adapter;
      if (overrides?.[id]) a = overrides[id]!;
      else if (demo) a = createMockAdapter(id);
      else if (id === 'claude') a = createClaudeAdapter(bin, extra);
      else if (id === 'codex') a = createCodexAdapter(bin, extra);
      else a = this.geminiAdapter(bin, extra);
      this.adapters.set(id, a);
    }
  }

  private geminiAdapter(bin: () => string, extra: () => string[]): Adapter {
    // Chosen per call so switching CLIs in Settings takes effect without a restart.
    const agy = createAntigravityAdapter(bin, extra);
    const legacy = createGeminiAdapter(bin, extra);
    const pick = () => (this.cfg().providers.gemini.cli === 'gemini-cli' ? legacy : agy);
    return { id: 'gemini', available: () => pick().available(), run: (req) => pick().run(req) };
  }

  get(id: RealProviderId): Adapter {
    return this.adapters.get(id)!;
  }

  availability(id: RealProviderId): Availability {
    return this.avail.get(id) ?? { installed: false, version: null, checkedAt: 0 };
  }

  binFor(id: RealProviderId): string {
    const b = this.cfg().providers[id].bin;
    return this.resolved.get(b) ?? b;
  }

  /** enabled in config and installed */
  usable(id: RealProviderId): boolean {
    return this.cfg().providers[id].enabled && this.availability(id).installed;
  }

  async refresh(): Promise<void> {
    await Promise.all(REAL_PROVIDERS.map(async (id) => {
      let r = await this.get(id).available();
      if (!r.installed && !this.demo) {
        const bin = this.cfg().providers[id].bin;
        const abs = (await resolveViaLoginShell(bin)) ?? resolveFromCommonDirs(bin);
        if (abs) {
          this.resolved.set(bin, abs);
          r = await this.get(id).available();
        }
      }
      this.avail.set(id, { installed: r.installed, version: r.version ?? null, checkedAt: Date.now() });
    }));
  }
}
