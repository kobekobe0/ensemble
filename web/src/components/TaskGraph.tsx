// Layered DAG layout by dependency depth (no graph library).
import type { Task } from '../types';
import { label } from '../util';

const W = 190, H = 58, GX = 60, GY = 16;
const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--fg-3)', running: 'var(--info)', testing: 'var(--info)', reviewing: 'var(--info)', fixing: 'var(--info)',
  waiting_limit: 'var(--warn)', awaiting_approval: 'var(--accent)', merged: 'var(--ok)', rejected: 'var(--bad)',
  failed: 'var(--bad)', no_changes: 'var(--fg-3)', stopped: 'var(--fg-3)',
};
const PROV_COLOR: Record<string, string> = { claude: 'var(--claude)', codex: 'var(--codex)', gemini: 'var(--gemini)' };

export function TaskGraph({ tasks, focused, onFocus }: { tasks: Task[]; focused: string | null; onFocus: (id: string) => void }) {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const depthOf = (k: string, seen = new Set<string>()): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const t = byKey.get(k);
    const d = t && t.dependsOn.length ? 1 + Math.max(...t.dependsOn.filter((x) => byKey.has(x)).map((x) => depthOf(x, seen)), -1) : 0;
    depth.set(k, d);
    return d;
  };
  tasks.forEach((t) => depthOf(t.key));
  const layers: Task[][] = [];
  for (const t of tasks) (layers[depth.get(t.key)!] ??= []).push(t);
  const pos = new Map<string, { x: number; y: number }>();
  const maxRows = Math.max(1, ...layers.map((l) => l?.length ?? 0));
  layers.forEach((layer, li) => {
    const offset = ((maxRows - layer.length) * (H + GY)) / 2;
    layer.forEach((t, i) => pos.set(t.key, { x: 8 + li * (W + GX), y: 8 + offset + i * (H + GY) }));
  });
  const width = 16 + layers.length * W + (layers.length - 1) * GX;
  const height = 16 + maxRows * H + (maxRows - 1) * GY;

  return (
    <div className="graph-wrap">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Task dependency graph">
        {tasks.flatMap((t) => t.dependsOn.filter((d) => pos.has(d)).map((d) => {
          const a = pos.get(d)!, b = pos.get(t.key)!;
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
          return <path key={`${d}-${t.key}`} className="graph-edge" d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`} markerEnd="url(#arrow)" />;
        }))}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line-2)" />
          </marker>
        </defs>
        {tasks.map((t) => {
          const p = pos.get(t.key)!;
          const sc = STATUS_COLOR[t.status] ?? 'var(--fg-3)';
          return (
            <g key={t.id} className={`graph-node ${focused === t.id ? 'focused' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => onFocus(t.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onFocus(t.id); }}>
              <title>{`${t.key}: ${t.title} — ${label(t.status)}`}</title>
              <rect width={W} height={H} rx={9} />
              <rect width={5} height={H} rx={2} style={{ fill: sc, stroke: 'none' }} />
              <text x={14} y={20}>{t.key} · {t.title.length > 20 ? t.title.slice(0, 19) + '…' : t.title}</text>
              <circle cx={18} cy={39} r={4} style={{ fill: PROV_COLOR[t.provider ?? ''] ?? 'var(--fg-3)' }} />
              <text className="sub" x={27} y={42}>{t.provider ?? 'unassigned'}{t.model ? `/${t.model.slice(0, 10)}` : ''}</text>
              <text className="sub" x={W - 8} y={42} textAnchor="end" style={{ fill: sc }}>{label(t.status)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
