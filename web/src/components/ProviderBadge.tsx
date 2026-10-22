const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

export function ProviderBadge({ provider, model, showDefault = false }: { provider: string | null | undefined; model?: string | null; showDefault?: boolean }) {
  if (!provider) return <span className="chip">unassigned</span>;
  const m = model || (showDefault ? 'default' : '');
  return (
    <span className={`prov ${provider}`} title={`${NAMES[provider] ?? provider}${model ? ` / ${model}` : ' (CLI default model)'}`}>
      {NAMES[provider] ?? provider}
      {m && <span className="model">· {m}</span>}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`status s-${status}`}>{status.replace(/_/g, ' ')}</span>;
}
