// Tiny global store (providers, toasts, connection, navigation) on top of useSyncExternalStore.
import { useSyncExternalStore } from 'react';
import { socket } from './ws';
import type { ProviderStatus } from './types';

export interface Toast { id: number; title: string; body: string; url?: string; kind?: 'info' | 'error' }

interface State {
  providers: ProviderStatus[];
  toasts: Toast[];
  connected: boolean;
  demo: boolean;
  path: string;
}

let state: State = { providers: [], toasts: [], connected: false, demo: false, path: location.pathname };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const s of subs) s(); };

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state));
}
export const getState = () => state;

let toastId = 0;
export function toast(title: string, body = '', url?: string, kind: Toast['kind'] = 'info') {
  const t: Toast = { id: ++toastId, title, body, url, kind };
  set({ toasts: [...state.toasts.slice(-4), t] });
  setTimeout(() => dismissToast(t.id), kind === 'error' ? 9000 : 6000);
}
export function dismissToast(id: number) { set({ toasts: state.toasts.filter((t) => t.id !== id) }); }
export function errorToast(e: unknown) { toast('Error', (e as Error)?.message ?? String(e), undefined, 'error'); }

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  set({ path: location.pathname });
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => set({ path: location.pathname }));

function systemNotify(title: string, body: string, url?: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return; // toast is enough
  try {
    const n = new Notification(title, { body, icon: '/icon-192.png', tag: url ?? title });
    n.onclick = () => { window.focus(); if (url) navigate(url); n.close(); };
  } catch { /* iOS Safari outside a home-screen app */ }
}

export function initStore() {
  socket.on((m) => {
    if (m.type === 'hello') set({ demo: m.demo });
    else if (m.type === 'providers') set({ providers: m.providers });
    else if (m.type === 'notify') { toast(m.title, m.body, m.url); systemNotify(m.title, m.body, m.url); }
  });
  socket.onConn((c) => set({ connected: c }));
  socket.start();
}
