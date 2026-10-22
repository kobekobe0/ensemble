// Keep the Mac awake while runs are active (§15). No-op on other platforms.
import { spawn, type ChildProcess } from 'node:child_process';

export class KeepAwake {
  private child: ChildProcess | null = null;

  set(active: boolean) {
    if (process.platform !== 'darwin') return;
    if (active && !this.child) {
      try {
        // -w ties caffeinate to our pid, so it exits even if the server crashes.
        this.child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        this.child.on('exit', () => { this.child = null; });
        this.child.on('error', () => { this.child = null; });
      } catch { this.child = null; }
    } else if (!active && this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  get active() { return !!this.child; }
}
