import { useState } from 'react';
import { api } from '../api';
import { errorToast, useStore } from '../store';
import type { ProviderStatus } from '../types';
import { fmtTime, fmtTokens } from '../util';
import { ProviderBadge } from './ProviderBadge';

export function UsageBar({ p }: { p: ProviderStatus }) {
  const ratio = p.budgetPer5h > 0 ? p.usage5h.calls / p.budgetPer5h : 0;
  return (
    <div>
      <div className={`usage ${p.id} ${ratio >= 1 ? 'over' : ''}`} role="meter" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.id} usage estimate`}>
        <div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <div className="spread small dim" style={{ marginTop: 3 }}>
        <span>{p.usage5h.calls}/{p.budgetPer5h} runs · 5h (estimate)</span>
        <span>{fmtTokens(p.usage5h.inputTokens + p.usage5h.outputTokens)} tok · 7d {p.usage7d.calls}</span>
      </div>
    </div>
  );
}

function ProviderCard({ p, controls }: { p: ProviderStatus; controls: boolean }) {
  const [editing, setEditing] = useState(false);
  const [until, setUntil] = useState(() => {
    const d = new Date(Date.now() + 3_600_000);
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const limited = p.limitedUntil && p.limitedUntil > Date.now();
  return (
    <div className="provider-card">
      <div className="spread">
        <ProviderBadge provider={p.id} />
        <span className="small dim ellipsis" title={p.bin}>
          {!p.enabled ? 'disabled' : p.installed ? (p.version ?? 'installed') : 'not installed'}
        </span>
      </div>
      <div className="row wrap small">
        <span className="muted">{p.running} running · max {p.maxConcurrent}</span>
        {limited && <span className="status s-waiting_limit" title={p.limitMessage ?? ''}>limited until {fmtTime(p.limitedUntil)}</span>}
      </div>
      <UsageBar p={p} />
      {controls && (
        <div className="row wrap">
          {limited
            ? <button className="sm" onClick={() => api.clearLimit(p.id).catch(errorToast)}>Clear limit</button>
            : editing
              ? <>
                  <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Limited until" style={{ padding: '2px 6px', fontSize: 12 }} />
                  <button className="sm" onClick={() => { api.setLimit(p.id, new Date(until).getTime()).then(() => setEditing(false)).catch(errorToast); }}>Set</button>
                  <button className="sm ghost" onClick={() => setEditing(false)}>Cancel</button>
                </>
              : <button className="sm ghost" onClick={() => setEditing(true)}>Mark as limited until…</button>}
        </div>
      )}
    </div>
  );
}

export function ProviderStrip({ controls = true }: { controls?: boolean }) {
  const providers = useStore((s) => s.providers);
  if (!providers.length) return <div className="small dim">Loading providers…</div>;
  return <div className="providers">{providers.map((p) => <ProviderCard key={p.id} p={p} controls={controls} />)}</div>;
}
