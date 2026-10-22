import { useEffect, useState } from 'react';
import { api } from '../api';
import { ProviderBadge } from '../components/ProviderBadge';
import { ProviderStrip } from '../components/ProviderStrip';
import { errorToast, toast, useStore } from '../store';
import type { Config, ModelRef, ProviderConfig, RealProviderId, RoutingStat, TaskType } from '../types';
import { applyTheme, fmtDuration, getTheme } from '../util';

const PROVIDERS: RealProviderId[] = ['claude', 'codex', 'gemini'];
const TYPES: TaskType[] = ['plan', 'architecture', 'implement', 'refactor', 'ui', 'tests', 'small-fix', 'analysis', 'docs', 'review'];

function splitArgs(s: string): string[] {
  // Shell-like split honouring "double" and 'single' quotes, e.g. --allowedTools "Bash(npm *)"
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const joinArgs = (a: string[]) => a.map((x) => (/[\s"']/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ');

function RoutingRow({ type, list, onChange }: { type: TaskType; list: ModelRef[]; onChange: (l: ModelRef[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= list.length) return;
    const n = list.slice();
    const [x] = n.splice(from, 1);
    n.splice(to, 0, x);
    onChange(n);
  };
  return (
    <tr>
      <td className="mono nowrap">{type}</td>
      <td>
        <div className="routing-row">
          {list.map((r, i) => (
            <div key={i} className={`routing-item ${over === i ? 'drag-over' : ''}`} draggable
              onDragStart={() => setDrag(i)} onDragEnd={() => { setDrag(null); setOver(null); }}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}>
              <span className="dim small" aria-hidden>{i + 1}.</span>
              <select value={r.provider} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, provider: e.target.value as RealProviderId } : x)))} aria-label="Provider">
                {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
              </select>
              <input value={r.model} placeholder="CLI default" onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} aria-label="Model" />
              <button className="sm ghost" title="Move earlier" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
              <button className="sm ghost" title="Remove" disabled={list.length === 1} onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="sm ghost" onClick={() => onChange([...list, { provider: 'claude', model: '' }])}>+ add</button>
        </div>
      </td>
    </tr>
  );
}

function ProviderSettings({ id, pc, onChange }: { id: RealProviderId; pc: ProviderConfig; onChange: (p: ProviderConfig) => void }) {
  const [args, setArgs] = useState(joinArgs(pc.extraArgs));
  useEffect(() => setArgs(joinArgs(pc.extraArgs)), [pc.extraArgs]);
  return (
    <div className="review-item">
      <div className="spread"><ProviderBadge provider={id} /><label className="check"><input type="checkbox" checked={pc.enabled} onChange={(e) => onChange({ ...pc, enabled: e.target.checked })} /> enabled</label></div>
      <div className="grid2" style={{ gap: 8 }}>
        <label className="field">Binary (name or absolute path)<input className="mono" value={pc.bin} onChange={(e) => onChange({ ...pc, bin: e.target.value })} /></label>
        <label className="field">Extra args (appended to every call)<input className="mono" value={args} placeholder='e.g. --allowedTools "Bash(npm *)"' onChange={(e) => setArgs(e.target.value)} onBlur={() => onChange({ ...pc, extraArgs: splitArgs(args) })} /></label>
        <label className="field">Max concurrent<input type="number" min={1} value={pc.maxConcurrent} onChange={(e) => onChange({ ...pc, maxConcurrent: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label className="field">Budget (agent runs per 5h, estimate)<input type="number" min={1} value={pc.budgetPer5h} onChange={(e) => onChange({ ...pc, budgetPer5h: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label className="field">Limit cooldown (min, when no reset time is given)<input type="number" min={1} value={pc.limitCooldownMinutes} onChange={(e) => onChange({ ...pc, limitCooldownMinutes: Math.max(1, Number(e.target.value) || 1) })} /></label>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [stats, setStats] = useState<RoutingStat[]>([]);
  const [theme, setTheme] = useState(getTheme());
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [token, setToken] = useState(() => { try { return localStorage.getItem('ensemble.token') ?? ''; } catch { return ''; } });
  const demo = useStore((s) => s.demo);

  useEffect(() => {
    api.settings().then((c) => { setCfg(c); setSaved(JSON.stringify(c)); }).catch(errorToast);
    api.routingStats().then(setStats).catch(() => {});
  }, []);
  if (!cfg) return <div className="page narrow"><div className="dim">Loading…</div></div>;
  const dirty = JSON.stringify(cfg) !== saved;
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    try {
      const c = await api.saveSettings(cfg);
      setCfg(c); setSaved(JSON.stringify(c));
      toast('Settings saved', cfg.host !== JSON.parse(saved).host || cfg.port !== JSON.parse(saved).port ? 'Restart the server for host/port changes.' : '');
    } catch (e) { errorToast(e); }
  };

  return (
    <div className="page narrow">
      <div className="spread" style={{ position: 'sticky', top: 52, zIndex: 5, background: 'var(--bg)', padding: '6px 0' }}>
        <h1>Settings</h1>
        <div className="row">{dirty && <span className="small dim">unsaved changes</span>}<button className="primary" disabled={!dirty} onClick={save}>Save</button></div>
      </div>
      {demo && <div className="banner info">Demo mode: all providers are simulated by the mock agent. Data and settings live in the demo data folder (~/.ensemble-demo unless ENSEMBLE_HOME is set).</div>}

      <div className="card">
        <h2>Providers</h2>
        <ProviderStrip />
        <div className="row" style={{ margin: '8px 0' }}><button className="sm" onClick={() => api.refreshProviders().catch(errorToast)}>Re-check installed CLIs</button></div>
        <div className="col">
          {PROVIDERS.map((p) => <ProviderSettings key={p} id={p} pc={cfg.providers[p]} onChange={(pc) => set('providers', { ...cfg.providers, [p]: pc })} />)}
        </div>
      </div>

      <div className="card">
        <h2>Routing</h2>
        <div className="small muted" style={{ marginBottom: 8 }}>Ordered preference per task type — drag to reorder (or use ↑). Empty model = the CLI's own default. Review always excludes the author's provider.</div>
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <label className="field">Lead (planning)
            <div className="row">
              <select value={cfg.lead.provider} onChange={(e) => set('lead', { ...cfg.lead, provider: e.target.value as RealProviderId })}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select>
              <input value={cfg.lead.model} placeholder="CLI default" onChange={(e) => set('lead', { ...cfg.lead, model: e.target.value })} style={{ width: 130 }} />
            </div>
          </label>
          <label className="check"><input type="checkbox" checked={cfg.learnRouting} onChange={(e) => set('learnRouting', e.target.checked)} /> Learn from outcomes (reorder after ≥ 5 results each)</label>
        </div>
        <div className="table-wrap">
          <table className="data"><tbody>
            {TYPES.map((t) => <RoutingRow key={t} type={t} list={cfg.routing[t]} onChange={(l) => set('routing', { ...cfg.routing, [t]: l })} />)}
          </tbody></table>
        </div>
      </div>

      <div className="card">
        <h2>Pipeline</h2>
        <div className="grid2" style={{ gap: 10 }}>
          <label className="field">When a provider hits its limit
            <select value={cfg.onLimit} onChange={(e) => set('onLimit', e.target.value as Config['onLimit'])}>
              <option value="handoff">Hand off to another provider</option>
              <option value="wait">Wait for the reset</option>
            </select>
          </label>
          <label className="field">Max parallel tasks<input type="number" min={1} value={cfg.maxParallel} onChange={(e) => set('maxParallel', Math.max(1, Number(e.target.value) || 1))} /></label>
          <label className="field">Test fix retries<input type="number" min={0} value={cfg.maxTestRetries} onChange={(e) => set('maxTestRetries', Math.max(0, Number(e.target.value) || 0))} /></label>
          <label className="field">Review fix rounds<input type="number" min={0} value={cfg.maxReviewFixRounds} onChange={(e) => set('maxReviewFixRounds', Math.max(0, Number(e.target.value) || 0))} /></label>
          <label className="field">Agent timeout (min)<input type="number" min={1} value={cfg.agentTimeoutMinutes} onChange={(e) => set('agentTimeoutMinutes', Math.max(1, Number(e.target.value) || 1))} /></label>
          <label className="field">Test timeout (min)<input type="number" min={1} value={cfg.testTimeoutMinutes} onChange={(e) => set('testTimeoutMinutes', Math.max(1, Number(e.target.value) || 1))} /></label>
        </div>
        <div className="col" style={{ marginTop: 10 }}>
          <label className="check"><input type="checkbox" checked={cfg.reviewPlanBeforeStart} onChange={(e) => set('reviewPlanBeforeStart', e.target.checked)} /> Review plan before starting (default for new runs)</label>
          <label className="check"><input type="checkbox" checked={cfg.keepAwake} onChange={(e) => set('keepAwake', e.target.checked)} /> Keep the Mac awake while agents run (caffeinate)</label>
        </div>
      </div>

      <div className="card">
        <h2>Folders</h2>
        <label className="field">Allowed roots (one per line — the folder browser and project registration are limited to these)
          <textarea className="mono" rows={4} value={cfg.allowedRoots.join('\n')} onChange={(e) => set('allowedRoots', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
        </label>
        <label className="field" style={{ marginTop: 8 }}>Worktree directory<input className="mono" value={cfg.worktreeDir} onChange={(e) => set('worktreeDir', e.target.value)} /></label>
        <div className="grid2" style={{ gap: 10, marginTop: 8 }}>
          <label className="field">Host (restart required; non-loopback needs ENSEMBLE_TOKEN)<input className="mono" value={cfg.host} onChange={(e) => set('host', e.target.value)} /></label>
          <label className="field">Port (restart required)<input type="number" value={cfg.port} onChange={(e) => set('port', Number(e.target.value) || 4317)} /></label>
        </div>
        {cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && <div className="banner warn" style={{ marginTop: 8 }}>The server is reachable beyond this Mac. Prefer 127.0.0.1 + <code>tailscale serve</code>.</div>}
      </div>

      <div className="card">
        <h2>Notifications &amp; appearance</h2>
        <div className="col">
          <label className="field">ntfy.sh topic (phone push even when the dashboard is closed)
            <div className="row">
              <input className="mono grow" value={cfg.ntfyTopic ?? ''} placeholder="e.g. ensemble-7f3k2q (pick something hard to guess)" onChange={(e) => set('ntfyTopic', e.target.value.trim() || null)} />
              <button className="sm" disabled={dirty} title={dirty ? 'Save first' : ''} onClick={() => api.testNotification().then((r) => toast('Test sent', r.ntfy ? 'Check your phone' : 'In-app only (no ntfy topic)')).catch(errorToast)}>Send test notification</button>
            </div>
          </label>
          <div className="row wrap">
            <span className="small muted">Browser notifications: {notif}</span>
            {notif === 'default' && <button className="sm" onClick={() => Notification.requestPermission().then(setNotif)}>Enable</button>}
          </div>
          <label className="field">Theme
            <select value={theme} onChange={(e) => { const t = e.target.value as 'dark' | 'light' | 'system'; setTheme(t); applyTheme(t); }} style={{ maxWidth: 200 }}>
              <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
            </select>
          </label>
          <label className="field">Access token (only when the server requires ENSEMBLE_TOKEN; stored in this browser)
            <div className="row"><input className="mono grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
              <button className="sm" onClick={() => { try { localStorage.setItem('ensemble.token', token); } catch { /* ignore */ } toast('Token saved', 'Reload to reconnect'); }}>Save</button></div>
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Routing stats</h2>
        {stats.length === 0 ? <div className="small dim">No outcomes yet. Each task that reaches review adds one.</div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th>Provider / model</th><th>n</th><th>First-try pass</th><th>Avg critical</th><th>Approved</th><th>Avg time</th></tr></thead>
              <tbody>{stats.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{s.taskType}</td>
                  <td><ProviderBadge provider={s.provider} model={s.model} showDefault /></td>
                  <td>{s.n}</td><td>{Math.round(s.passRate * 100)}%</td><td>{s.avgCritical.toFixed(2)}</td>
                  <td>{s.approvalRate === null ? '—' : `${Math.round(s.approvalRate * 100)}%`}</td>
                  <td>{fmtDuration(s.avgDurationMs)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
