// WebSocket client with exponential-backoff reconnect (§13.2). Pages listen for `reconnect`
// and replay /events?after=<lastEventId> so nothing is lost while disconnected.
import type { WsServerMessage } from './types';

type Listener = (m: WsServerMessage) => void;
type ConnListener = (connected: boolean, reconnected: boolean) => void;

class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private connListeners = new Set<ConnListener>();
  private delay = 1000;
  private everConnected = false;
  private timer: number | null = null;
  connected = false;

  start() {
    if (this.ws) return;
    this.open();
    document.addEventListener('visibilitychange', () => {
      // iOS suspends sockets in the background; reconnect immediately when we come back.
      if (document.visibilityState === 'visible' && !this.connected) this.retryNow();
    });
  }

  private url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let t: string | null = null;
    try { t = localStorage.getItem('ensemble.token'); } catch { /* ignore */ }
    return `${proto}//${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ''}`;
  }

  private open() {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      const re = this.everConnected;
      this.everConnected = true;
      this.connected = true;
      this.delay = 1000;
      for (const fn of this.connListeners) fn(true, re);
    };
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) for (const fn of this.connListeners) fn(false, false);
      this.schedule();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private schedule() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = null; this.open(); }, this.delay);
    this.delay = Math.min(this.delay * 2, 10_000);
  }

  private retryNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.ws) this.open();
  }

  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  onConn(fn: ConnListener) { this.connListeners.add(fn); return () => { this.connListeners.delete(fn); }; }
  send(obj: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
}

export const socket = new Socket();
