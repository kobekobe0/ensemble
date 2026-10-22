import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { FolderBrowser } from '../components/FolderBrowser';
import { ProviderStrip } from '../components/ProviderStrip';
import { errorToast, navigate } from '../store';
import type { Project } from '../types';
import { ago } from '../util';

export function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [notGit, setNotGit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.projects().then(setProjects).catch(errorToast); }, []);

  const open = async (path: string) => {
    setBusy(true); setError(null); setNotGit(null);
    try {
      const p = await api.openProject(path);
      navigate(`/projects/${p.id}`);
    } catch (e) {
      const err = e as ApiError;
      if (err.body?.notGit) setNotGit(err.body.path ?? path);
      else setError(err.message);
    } finally { setBusy(false); }
  };

  const initGit = async () => {
    if (!notGit) return;
    setBusy(true);
    try { const p = await api.initProject(notGit); navigate(`/projects/${p.id}`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page">
      <ProviderStrip />
      <div className="grid2">
        <div className="card">
          <h2>Open a project</h2>
          <div className="col">
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (pathInput.trim()) void open(pathInput.trim()); }}>
              <input className="grow" placeholder="Paste a path, e.g. ~/Projects/my-app" value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Project path" />
              <button className="primary" disabled={busy || !pathInput.trim()}>Open</button>
            </form>
            {error && <div className="banner bad">{error}</div>}
            {notGit && (
              <div className="banner warn">
                <div><span className="mono">{notGit}</span> is not a git repository.</div>
                <div style={{ marginTop: 6 }}><button className="sm" disabled={busy} onClick={initGit}>Initialize git here</button> <span className="small">(runs <code>git init</code> and makes an initial commit)</span></div>
              </div>
            )}
            <FolderBrowser onOpen={(p) => void open(p)} />
          </div>
        </div>
        <div className="card">
          <h2>Recent projects</h2>
          {projects === null ? <div className="small dim">Loading…</div> : projects.length === 0 ? (
            <div className="small dim">No projects yet. Pick a git repository on the left — projects stay where they are on disk.</div>
          ) : (
            <div className="list">
              {projects.map((p) => (
                <a key={p.id} className="list-item" href={`/projects/${p.id}`} onClick={(e) => { e.preventDefault(); navigate(`/projects/${p.id}`); }}>
                  <div className="grow">
                    <div className="ellipsis"><strong>{p.name}</strong></div>
                    <div className="small dim ellipsis mono">{p.path}</div>
                  </div>
                  <div className="row wrap hide-sm">{p.stack.kinds.slice(0, 3).map((k) => <span key={k} className="chip">{k}</span>)}</div>
                  <span className="small dim nowrap">{ago(p.lastOpened)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
