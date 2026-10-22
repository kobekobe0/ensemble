import { memo, useMemo, type ReactNode } from 'react';

interface Line { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; a?: number; b?: number }
interface FileDiff { path: string; lines: Line[]; added: number; removed: number; binary: boolean }

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let a = 0, b = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.*)$/);
      cur = { path: m?.[1] ?? raw.slice(11), lines: [], added: 0, removed: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      a = Number(m?.[1] ?? 0); b = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('Binary files')) {
      cur.binary = true;
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      if (raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('rename ')) cur.lines.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: raw.slice(1), b: b++ }); cur.added++;
    } else if (raw.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: raw.slice(1), a: a++ }); cur.removed++;
    } else if (raw.startsWith(' ')) {
      if (cur.lines.length) cur.lines.push({ kind: 'ctx', text: raw.slice(1), a: a++, b: b++ });
    }
  }
  return files;
}

const KW = /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|new|async|await|try|catch|throw|interface|type|extends|public|private|static|def|fn|func|package|struct|impl|use|pub|true|false|null|undefined|None|self|this)\b/;
const TOKEN = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)/g;

function highlight(text: string, lang: string): ReactNode {
  if (text.length > 400 || !lang) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (m[1] && m[1].startsWith('#') && !['py', 'sh', 'rb', 'yaml', 'yml', 'toml'].includes(lang)) continue;
    if (idx > last) out.push(text.slice(last, idx));
    if (m[1]) out.push(<span key={i++} className="tok-c">{m[1]}</span>);
    else if (m[2]) out.push(<span key={i++} className="tok-s">{m[2]}</span>);
    else if (m[3]) out.push(<span key={i++} className="tok-n">{m[3]}</span>);
    else if (m[4] && KW.test(m[4])) out.push(<span key={i++} className="tok-k">{m[4]}</span>);
    else out.push(m[0]);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const FileView = memo(function FileView({ f, open }: { f: FileDiff; open: boolean }) {
  const lang = (f.path.split('.').pop() ?? '').toLowerCase();
  return (
    <details className="diff-file" open={open}>
      <summary>
        <span className="path">{f.path}</span>
        <span className="plus">+{f.added}</span><span className="minus">−{f.removed}</span>
      </summary>
      {f.binary ? <div className="small dim" style={{ padding: 8 }}>Binary file</div> : (
        <div className="diff-lines">
          <table><tbody>
            {f.lines.map((l, i) => (
              <tr key={i} className={l.kind}>
                <td className="ln">{l.kind === 'hunk' || l.kind === 'meta' ? '' : l.a ?? ''}</td>
                <td className="ln">{l.kind === 'hunk' || l.kind === 'meta' ? '' : l.b ?? ''}</td>
                <td>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}{l.kind === 'hunk' || l.kind === 'meta' ? l.text : highlight(l.text, lang)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </details>
  );
});

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) return <div className="small dim">No changes.</div>;
  const total = files.reduce((n, f) => n + f.lines.length, 0);
  return (
    <div className="col">
      <div className="small muted">{files.length} file{files.length === 1 ? '' : 's'} · <span className="plus">+{files.reduce((n, f) => n + f.added, 0)}</span> <span className="minus">−{files.reduce((n, f) => n + f.removed, 0)}</span>{truncated && ' · diff truncated to 200 KB'}</div>
      <div className="diff">{files.map((f) => <FileView key={f.path} f={f} open={total < 1500 || files.length === 1} />)}</div>
    </div>
  );
}
