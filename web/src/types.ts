export type * from '../../server/src/types';
import type { Project, Run, StackInfo } from '../../server/src/types';

export interface RunListItem extends Run { taskCount: number; taskCounts: Record<string, number> }
export interface FsEntry { name: string; path: string; isGitRepo: boolean }
export interface FsListing { path: string | null; root?: string; parent: string | null; entries: FsEntry[]; isGitRepo: boolean; roots?: boolean }
export interface ProjectInfo {
  project: Project; exists: boolean; isGitRepo: boolean; branch: string | null; dirty: boolean; dirtyFiles: string[];
  agentFiles: Record<'AGENTS.md' | 'CLAUDE.md' | 'GEMINI.md', { exists: boolean; symlink: boolean }>;
}
export interface RoutingStat { provider: string; model: string; taskType: string; n: number; passRate: number; avgCritical: number; approvalRate: number | null; avgDurationMs: number }
export type { StackInfo };
