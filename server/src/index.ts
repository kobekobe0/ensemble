// Entry point: `pnpm start` / `pnpm demo`.
import { isDemo } from './config.js';
import { Engine } from './engine.js';
import { buildServer } from './server.js';

const engine = new Engine();
const extraHosts = (process.env.ENSEMBLE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const app = await buildServer(engine, { allowedOriginHosts: extraHosts });
await engine.start();
const { host, port } = engine.config;
await app.listen({ host, port });
const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
engine.bus.publicUrl = () => process.env.ENSEMBLE_PUBLIC_URL ?? url;
console.log(`Ensemble ${isDemo() ? '(demo mode — mock agents) ' : ''}listening on ${url}`);
for (const p of engine.providerStatuses()) {
  console.log(`  ${p.id.padEnd(7)} ${p.installed ? `✓ ${p.version ?? ''}` : '✗ not found'}${p.enabled ? '' : ' (disabled)'}`);
}

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} — shutting down`);
  await app.close().catch(() => {});
  await engine.shutdown().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
