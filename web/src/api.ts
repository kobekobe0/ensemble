import type {
  Config, FsListing, ModelRef, Project, ProjectInfo, ProviderStatus, RoutingStat, Run, RunListItem, StoredEvent, Task,
} from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, any>) { super(message); }
}

function token(): string | null {
  try { return localStorage.getItem('ensemble.token'); } catch { return null; }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data ?? {});
  return data as T;
}

const q = (o: Record<string, string | number | undefined | null>) => {
  const s = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `?${s}` : '';
};

export const api = {
  health: () => req<{ ok: boolean; version: string; demo: boolean; remote: boolean }>('GET', '/api/health'),
  fs: (path?: string, hidden = false) => req<FsListing>('GET', `/api/fs${q({ path, hidden: hidden ? 1 : undefined })}`),
  projects: () => req<Project[]>('GET', '/api/projects'),
  openProject: (path: string) => req<Project>('POST', '/api/projects', { path }),
  initProject: (path: string) => req<Project>('POST', '/api/projects/init', { path }),
  patchProject: (id: string, patch: Partial<Pick<Project, 'testCommand' | 'setupCommand' | 'linkNodeModules' | 'name'>>) => req<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${id}`),
  projectInfo: (id: string) => req<ProjectInfo>('GET', `/api/projects/${id}/info`),
  draftAgentsMd: (id: string) => req<{ runId: string; content: string }>('POST', `/api/projects/${id}/agents-md/draft`),
  saveAgentsMd: (id: string, content: string, linkAliases: boolean) => req<{ ok: boolean; written: string[] }>('PUT', `/api/projects/${id}/agents-md`, { content, linkAliases }),
  runs: (projectId?: string) => req<RunListItem[]>('GET', `/api/runs${q({ projectId })}`),
  createRun: (projectId: string, goal: string, lead?: ModelRef, reviewPlan?: boolean) => req<Run>('POST', '/api/runs', { projectId, goal, lead, reviewPlan }),
  run: (id: string) => req<{ run: Run; tasks: Task[]; project: Project | null }>('GET', `/api/runs/${id}`),
  events: (id: string, after = 0, limit = 2000) => req<{ events: StoredEvent[]; more: boolean }>('GET', `/api/runs/${id}/events${q({ after, limit })}`),
  startRun: (id: string) => req<Run>('POST', `/api/runs/${id}/start`),
  pauseRun: (id: string) => req<Run>('POST', `/api/runs/${id}/pause`),
  resumeRun: (id: string) => req<Run>('POST', `/api/runs/${id}/resume`),
  stopRun: (id: string) => req<Run>('POST', `/api/runs/${id}/stop`),
  deleteRun: (id: string) => req<{ ok: boolean }>('DELETE', `/api/runs/${id}`),
  cleanupBranches: (id: string) => req<{ ok: boolean }>('POST', `/api/runs/${id}/cleanup-branches`),
  patchTask: (id: string, patch: Partial<Task>) => req<Task>('PATCH', `/api/tasks/${id}`, patch),
  diff: (id: string) => req<{ stat: string; diff: string; truncated: boolean }>('GET', `/api/tasks/${id}/diff`),
  approve: (id: string) => req<Task>('POST', `/api/tasks/${id}/approve`),
  reject: (id: string, reason?: string) => req<Task>('POST', `/api/tasks/${id}/reject`, { reason }),
  retry: (id: string, o: { provider?: string; model?: string; instructions?: string } = {}) => req<Task>('POST', `/api/tasks/${id}/retry`, o),
  rebase: (id: string) => req<Task>('POST', `/api/tasks/${id}/rebase`),
  stopTask: (id: string) => req<Task>('POST', `/api/tasks/${id}/stop`),
  providers: () => req<ProviderStatus[]>('GET', '/api/providers'),
  refreshProviders: () => req<ProviderStatus[]>('POST', '/api/providers/refresh'),
  setLimit: (id: string, until: number) => req<ProviderStatus[]>('POST', `/api/providers/${id}/limit`, { until }),
  clearLimit: (id: string) => req<ProviderStatus[]>('DELETE', `/api/providers/${id}/limit`),
  settings: () => req<Config>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Config>) => req<Config>('PUT', '/api/settings', patch),
  testNotification: () => req<{ ok: boolean; ntfy: boolean }>('POST', '/api/settings/test-notification'),
  routingStats: () => req<RoutingStat[]>('GET', '/api/routing/stats'),
};

/** Fetch every stored event after `after`, following pagination. */
export async function allEvents(runId: string, after = 0): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  let cursor = after;
  for (let i = 0; i < 100; i++) {
    const page = await api.events(runId, cursor, 5000);
    out.push(...page.events);
    if (!page.more || !page.events.length) break;
    cursor = page.events[page.events.length - 1].id;
  }
  return out;
}
