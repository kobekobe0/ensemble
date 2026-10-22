import { useEffect } from 'react';
import { Toasts } from './components/Toasts';
import { AboutPage } from './pages/About';
import { Home } from './pages/Home';
import { ProjectPage } from './pages/Project';
import { RunPage } from './pages/Run';
import { SettingsPage } from './pages/Settings';
import { navigate, useStore } from './store';

function Link({ to, children, exact = false }: { to: string; children: React.ReactNode; exact?: boolean }) {
  const path = useStore((s) => s.path);
  const active = exact ? path === to : path.startsWith(to);
  return <a href={to} className={active ? 'active' : ''} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

export function App() {
  const path = useStore((s) => s.path);
  const connected = useStore((s) => s.connected);
  const demo = useStore((s) => s.demo);
  const running = useStore((s) => s.providers.reduce((n, p) => n + p.running, 0));

  useEffect(() => { document.title = running ? `(${running}) Ensemble` : 'Ensemble'; }, [running]);

  let page: React.ReactNode;
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/runs\/([^/]+)/))) page = <RunPage key={m[1]} id={m[1]} />;
  else if ((m = path.match(/^\/projects\/([^/]+)/))) page = <ProjectPage key={m[1]} id={m[1]} />;
  else if (path.startsWith('/settings')) page = <SettingsPage />;
  else if (path.startsWith('/about')) page = <AboutPage />;
  else page = <Home />;

  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          <img src="/icon.svg" alt="" /> Ensemble
        </a>
        {demo && <span className="chip" title="All providers are simulated">demo</span>}
        <nav>
          <Link to="/" exact>Projects</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/about">About</Link>
          <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} aria-label={connected ? 'connected' : 'disconnected'} />
        </nav>
      </header>
      {!connected && <div className="banner warn" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>Reconnecting to the Ensemble server…</div>}
      {page}
      <Toasts />
    </>
  );
}
