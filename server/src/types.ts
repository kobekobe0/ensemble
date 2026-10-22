// Shared types (spec §5). The web app imports these via a relative path, so keep this file free of runtime imports.

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'mock';
export type RealProviderId = 'claude' | 'codex' | 'gemini';
export const REAL_PROVIDERS: RealProviderId[] = ['claude', 'codex', 'gemini'];

export type TaskType =
  | 'plan' | 'architecture' | 'implement' | 'refactor' | 'ui' | 'tests'
  | 'small-fix' | 'analysis' | 'docs' | 'review';
export const TASK_TYPES: TaskType[] = [
  'plan', 'architecture', 'implement', 'refactor', 'ui', 'tests', 'small-fix', 'analysis', 'docs', 'review',
];
export type TaskSize = 'small' | 'medium' | 'large';

export type TaskStatus =
  | 'pending' | 'running' | 'testing' | 'reviewing' | 'fixing' | 'waiting_limit'
  | 'awaiting_approval' | 'merged' | 'rejected' | 'no_changes' | 'failed' | 'stopped';
export type RunStatus = 'planning' | 'plan_review' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';

export const TERMINAL_TASK: TaskStatus[] = ['merged', 'rejected', 'no_changes', 'failed', 'stopped'];
export const SETTLED_TASK: TaskStatus[] = [...TERMINAL_TASK, 'awaiting_approval'];
export const ACTIVE_TASK: TaskStatus[] = ['running', 'testing', 'reviewing', 'fixing'];

export type AgentEventKind =
  | 'system' | 'text' | 'thinking' | 'tool' | 'tool_result' | 'command' | 'file_change'
  | 'usage' | 'error' | 'limit' | 'log'
  | 'status' | 'test' | 'review';

export interface AgentEvent {
  kind: AgentEventKind;
  text?: string;
  data?: Record<string, unknown>;
}

export interface StoredEvent extends AgentEvent {
  id: number;
  runId: string;
  taskId: string | null;
  provider: string | null;
  ts: number;
}

export interface ModelRef { provider: RealProviderId; model: string }

export interface ReviewResult {
  verdict: 'approve' | 'changes';
  critical: string[];
  notes: string[];
  reviewer: ModelRef;
  selfReview?: boolean;
  parseFailed?: boolean;
}

export type AgentRole = 'plan' | 'work' | 'fix' | 'review' | 'agents_md';

export interface ProviderConfig {
  enabled: boolean;
  bin: string;
  maxConcurrent: number;
  extraArgs: string[];
  limitCooldownMinutes: number;
  budgetPer5h: number;
  /** gemini only: which CLI drives the provider. Gemini CLI no longer serves personal Google accounts. */
  cli?: 'antigravity' | 'gemini-cli';
}

export interface Config {
  host: string;
  port: number;
  allowedRoots: string[];
  worktreeDir: string;
  maxParallel: number;
  providers: Record<RealProviderId, ProviderConfig>;
  lead: ModelRef;
  routing: Record<TaskType, ModelRef[]>;
  learnRouting: boolean;
  onLimit: 'handoff' | 'wait';
  maxTestRetries: number;
  maxReviewFixRounds: number;
  agentTimeoutMinutes: number;
  testTimeoutMinutes: number;
  keepAwake: boolean;
  reviewPlanBeforeStart: boolean;
  ntfyTopic: string | null;
}

export interface StackInfo {
  kinds: string[];          // e.g. ["node", "react", "vite"]
  packageManager?: string;  // npm | pnpm | yarn | bun
  suggestedTest: string | null;
  suggestedSetup: string | null;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  stack: StackInfo;
  testCommand: string | null;
  setupCommand: string | null;
  linkNodeModules: boolean;
  lastOpened: number;
}

export interface Run {
  id: string;
  projectId: string;
  goal: string;
  status: RunStatus;
  baseBranch: string | null;
  baseCommit: string | null;
  lead: ModelRef;
  planSummary: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** true for the pseudo-run used by the AGENTS.md draft job */
  pseudo?: boolean;
}

export interface Task {
  id: string;
  runId: string;
  key: string;
  title: string;
  description: string;
  type: TaskType;
  size: TaskSize;
  dependsOn: string[];  // task keys
  provider: RealProviderId | null;
  model: string;
  status: TaskStatus;
  branch: string | null;
  worktree: string | null;
  sessionId: string | null;
  attempts: number;
  fixRounds: number;
  testStatus: 'pass' | 'fail' | 'skipped' | null;
  testOutput: string | null;
  review: ReviewResult | null;
  summary: string | null;
  error: string | null;
  handoffs: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** extra instructions from Retry with feedback / reject reason */
  feedback?: string | null;
  rejectReason?: string | null;
  /** commit the task branch is diffed against; defaults to the run's baseCommit (changes after "Rebase onto current branch") */
  baseCommit?: string | null;
}

export interface ProviderStatus {
  id: RealProviderId;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  bin: string;
  running: number;
  maxConcurrent: number;
  limitedUntil: number | null;
  limitMessage: string | null;
  usage5h: { calls: number; inputTokens: number; outputTokens: number };
  usage7d: { calls: number; inputTokens: number; outputTokens: number };
  budgetPer5h: number;
}

export type WsServerMessage =
  | { type: 'hello'; serverTime: number; demo: boolean }
  | { type: 'event'; event: StoredEvent }
  | { type: 'task'; task: Task }
  | { type: 'run'; run: Run }
  | { type: 'providers'; providers: ProviderStatus[] }
  | { type: 'notify'; title: string; body: string; url?: string };
