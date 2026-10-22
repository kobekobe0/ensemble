import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Config, RealProviderId } from '../types.js';
import { REAL_PROVIDERS } from '../types.js';
import type { Adapter } from './base.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
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

export class AdapterRegistry {
  private adapters = new Map<RealProviderId, Adapter>();
  private avail = new Map<RealProviderId, Availability>();
  /** absolute paths discovered through the login shell */
  private resolved = new Map<RealProviderId, string>();

  constructor(private cfg: () => Config, readonly demo: boolean, overrides?: Partial<Record<RealProviderId, Adapter>>) {
    for (const id of REAL_PROVIDERS) {
      const bin = () => this.resolved.get(id) ?? this.cfg().providers[id].bin;
      const extra = () => this.cfg().providers[id].extraArgs;
      let a: Adapter;
      if (overrides?.[id]) a = overrides[id]!;
      else if (demo) a = createMockAdapter(id);
      else if (id === 'claude') a = createClaudeAdapter(bin, extra);
      else if (id === 'codex') a = createCodexAdapter(bin, extra);
      else a = createGeminiAdapter(bin, extra);
      this.adapters.set(id, a);
    }
  }

  get(id: RealProviderId): Adapter {
    return this.adapters.get(id)!;
  }

  availability(id: RealProviderId): Availability {
    return this.avail.get(id) ?? { installed: false, version: null, checkedAt: 0 };
  }

  binFor(id: RealProviderId): string {
    return this.resolved.get(id) ?? this.cfg().providers[id].bin;
  }

  /** enabled in config and installed */
  usable(id: RealProviderId): boolean {
    return this.cfg().providers[id].enabled && this.availability(id).installed;
  }

  async refresh(): Promise<void> {
    await Promise.all(REAL_PROVIDERS.map(async (id) => {
      let r = await this.get(id).available();
      if (!r.installed && !this.demo) {
        const abs = await resolveViaLoginShell(this.cfg().providers[id].bin);
        if (abs) {
          this.resolved.set(id, abs);
          r = await this.get(id).available();
        }
      }
      this.avail.set(id, { installed: r.installed, version: r.version ?? null, checkedAt: Date.now() });
    }));
  }
}
