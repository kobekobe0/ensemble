import { dismissToast, navigate, useStore } from '../store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} onClick={() => { if (t.url) navigate(t.url); dismissToast(t.id); }}>
          <div className="t">{t.title}</div>
          {t.body && <div className="small muted">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
