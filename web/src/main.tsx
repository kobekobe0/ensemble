import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initStore } from './store';
import { applyTheme, getTheme } from './util';
import './styles.css';

applyTheme(getTheme());
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });
initStore();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
