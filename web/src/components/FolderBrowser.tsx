import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { FsListing } from '../types';

export function FolderBrowser({ onOpen }: { onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback((path?: string) => {
    setLoading(true);
    api.fs(path, hidden).then((l) => { setListing(l); setError(null); }).catch((e: ApiError) => setError(e.message)).finally(() => setLoading(false));
  }, [hidden]);

  useEffect(() => { load(listing?.path ?? undefined); }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Breadcrumbs start at the allowed root that contains the current folder.
  const crumbs = (() => {
    if (!listing?.path) return [];
    const root = listing.root ?? listing.path;
    const rest = listing.path.slice(root.length).split('/').filter(Boolean);
    const out = [{ name: root.split('/').pop() || root, path: root }];
    rest.forEach((name, i) => out.push({ name, path: root + '/' + rest.slice(0, i + 1).join('/') }));
    return out;
  })();

  return (
    <div className="col">
      <div className="spread">
        <div className="crumbs">
          <button onClick={() => load()}>Roots</button>
          {crumbs.slice(-4).map((c, i, arr) => (
            <span key={c.path} className="row" style={{ gap: 2 }}>
              <span className="sep">/</span>
              {i === arr.length - 1 ? <span className="ellipsis" style={{ maxWidth: 220 }}>{c.name}</span> : <button className="ellipsis" style={{ maxWidth: 160 }} onClick={() => load(c.path)}>{c.name}</button>}
            </span>
          ))}
        </div>
        <label className="check small"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
      </div>
      {error && <div className="banner bad">{error}</div>}
      <div className="folder-list" aria-busy={loading}>
        {listing?.parent && (
          <div className="folder-item" onClick={() => load(listing.parent!)}><span>↩</span><span className="name muted">..</span></div>
        )}
        {listing?.path && listing.isGitRepo && (
          <div className="folder-item" onClick={() => onOpen(listing.path!)}>
            <span>★</span><span className="name">Open this folder</span><span className="chip">git</span>
          </div>
        )}
        {listing?.entries.map((e) => (
          <div key={e.path} className="folder-item" onClick={() => (e.isGitRepo ? onOpen(e.path) : load(e.path))}>
            <span aria-hidden>{e.isGitRepo ? '◆' : '▸'}</span>
            <span className="name">{e.name}</span>
            {e.isGitRepo && <span className="chip">git</span>}
            {e.isGitRepo && <button className="sm ghost" onClick={(ev) => { ev.stopPropagation(); load(e.path); }}>browse</button>}
          </div>
        ))}
        {listing && !listing.entries.length && <div className="folder-item dim">No subfolders</div>}
      </div>
      {listing?.path && !listing.isGitRepo && (
        <div className="row"><button className="sm" onClick={() => onOpen(listing.path!)}>Use this folder…</button><span className="small dim">(not a git repo)</span></div>
      )}
    </div>
  );
}
