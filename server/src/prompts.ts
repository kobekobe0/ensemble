// All prompt templates and structured-output parsers (§9).
import type { ReviewResult, StackInfo, Task, TaskSize, TaskType } from './types.js';

const AGENTS_HINT = 'If the repository has an AGENTS.md (or CLAUDE.md / GEMINI.md), read it first and follow it.';

const HARD_RULES = `## Hard rules
- Work only inside the current directory. Do not run \`git commit\`, \`git push\`, \`git checkout\` or change branches — the orchestrator handles git.
- Do not modify files unrelated to the task. Keep changes minimal and consistent with the codebase's conventions.
- When done, reply with a short summary: what changed, files touched, anything left undone or risky.`;

const section = (title: string, body: string | null | undefined) => (body && body.trim() ? `## ${title}\n${body.trim()}\n\n` : '');

// ---- planning (§9.1) ------------------------------------------------------------------------

export function planningPrompt(i: {
  goal: string; projectName: string; stack: StackInfo; testCommand: string | null; tree: string; agentsMd: string | null;
}): string {
  return `You are the lead engineer planning work for a team of AI coding agents. Do not change any files — only read and plan.

${section('Goal', i.goal)}${section('Project', `${i.projectName}\nDetected stack: ${i.stack.kinds.join(', ') || 'unknown'}\nTest command: ${i.testCommand ?? '(none)'}`)}${section('File tree (depth 2)', '```\n' + i.tree + '\n```')}${section('AGENTS.md', i.agentsMd)}## Instructions
${AGENTS_HINT}
Break the goal into 1–8 subtasks. Each subtask must be small enough for one agent session, and should be independent of the others where possible.
Declare explicit dependencies only when a task truly needs another task's changes. Prefer fewer tasks for small goals (a one-line fix is 1 task).
Each agent works in its own git worktree; tasks that touch the same lines of the same file should be merged into one task or made dependent.
In each description, give detailed instructions: the files likely involved and clear acceptance criteria.

Task types: implement, refactor, ui, tests, small-fix, analysis, docs, architecture.
Sizes: small, medium, large. suggestedProvider is optional (claude | codex | gemini | null).

Reply with ONLY a JSON object in a \`\`\`json fenced block, matching:
\`\`\`json
{
  "summary": "one paragraph describing the approach",
  "tasks": [
    { "key": "t1", "title": "short title", "description": "detailed instructions incl. files likely involved and acceptance criteria",
      "type": "implement", "size": "medium", "dependsOn": [], "suggestedProvider": null }
  ]
}
\`\`\`
`;
}

export const PLAN_RETRY_PROMPT = 'Your previous reply could not be parsed. Return only valid JSON for the plan, in a single ```json fenced block, matching the schema I gave you. No other text.';

// ---- work / fix / handoff (§9.2, §9.3) -------------------------------------------------------

export function planOutline(tasks: Pick<Task, 'key' | 'title' | 'dependsOn'>[], current?: string): string {
  return tasks.map((t) => `- ${t.key}: ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}${t.key === current ? '  ← this task' : ''}`).join('\n');
}

export function workPrompt(i: {
  goal: string; planSummary: string | null; tasks: Pick<Task, 'key' | 'title' | 'dependsOn'>[]; task: Task;
  depSummaries: Array<{ key: string; title: string; summary: string | null }>; feedback?: string | null;
}): string {
  const deps = i.depSummaries.map((d) => `### ${d.key}: ${d.title}\n${d.summary ?? '(no summary)'}`).join('\n\n');
  return `You are one agent in a team working on the goal below. You are responsible for ONE task; other agents handle the other tasks in parallel, so stay inside your task's boundaries.

${section('Goal', i.goal)}${section('Plan', `${i.planSummary ?? ''}\n\n${planOutline(i.tasks, i.task.key)}`)}${section(`Your task (${i.task.key}): ${i.task.title}`, i.task.description)}${section('Already merged into your working copy (dependencies)', deps)}${section('Extra instructions from the user', i.feedback)}## Instructions
${AGENTS_HINT}
Implement the task fully in the current directory. Run the project's build/tests if you can.

${HARD_RULES}
`;
}

export function fixPrompt(i: { goal: string; task: Task; reason: 'tests' | 'review'; details: string; fresh: boolean }): string {
  const header = i.reason === 'tests'
    ? 'The project tests failed after your change. Here is the tail of the test output:'
    : 'A reviewer found critical issues in your change that must be fixed before merge:';
  const context = i.fresh ? `${section('Goal', i.goal)}${section(`Task (${i.task.key}): ${i.task.title}`, i.task.description)}${section('Previous agent summary', i.task.summary)}` : section('Goal', i.goal);
  return `${context}## ${i.reason === 'tests' ? 'Tests failed' : 'Reviewer found critical issues'}
${header}

\`\`\`
${i.details.trim()}
\`\`\`

## Instructions
${AGENTS_HINT}
Fix only what's needed to resolve the problems above; do not make unrelated changes.

${HARD_RULES}
`;
}

export function handoffPrompt(i: {
  goal: string; planSummary: string | null; tasks: Pick<Task, 'key' | 'title' | 'dependsOn'>[]; task: Task;
  fromProvider: string; previousText: string | null; diffStat: string;
}): string {
  return `You are taking over a task from another AI agent (${i.fromProvider}) that was interrupted by a usage limit. Its partial work is already in the current directory.

${section('Goal', i.goal)}${section('Plan', `${i.planSummary ?? ''}\n\n${planOutline(i.tasks, i.task.key)}`)}${section(`Your task (${i.task.key}): ${i.task.title}`, i.task.description)}${section("Previous agent's last message", i.previousText)}${section('Changes so far (git diff --stat against the base)', '```\n' + (i.diffStat.trim() || '(no changes yet)') + '\n```')}${section('Extra instructions from the user', i.task.feedback)}## Instructions
${AGENTS_HINT}
Continue from the current state: review what was already done, then finish the task.

${HARD_RULES}
`;
}

export const CONTINUE_PROMPT = `Continue the task where you left off.

${HARD_RULES}`;

// ---- review (§9.5) --------------------------------------------------------------------------

export function reviewPrompt(i: {
  goal: string; task: Task; authorSummary: string | null; testStatus: string | null; testOutput: string | null;
  stat: string; diff: string; diffTruncated: boolean;
}): string {
  return `You are a senior code reviewer. Review another AI agent's change. Do not modify any files.

${section('Goal', i.goal)}${section(`Task (${i.task.key}): ${i.task.title}`, i.task.description)}${section("Author's summary", i.authorSummary)}${section('Tests', `Status: ${i.testStatus ?? 'unknown'}${i.testOutput ? `\n\`\`\`\n${i.testOutput.slice(-4000)}\n\`\`\`` : ''}`)}${section('Diff stat', '```\n' + i.stat.trim() + '\n```')}## Diff${i.diffTruncated ? ' (truncated to 120 KB)' : ''}
\`\`\`diff
${i.diff}
\`\`\`

## Instructions
${AGENTS_HINT}
Look for bugs, security problems, broken behaviour, missing pieces of the task, and violations of AGENTS.md.
Only list an issue under "critical" if it MUST be fixed before merge. Style nits and suggestions go under "notes".
If there are no critical issues, the verdict is "approve".

Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{ "verdict": "approve", "critical": [], "notes": [] }
\`\`\`
`;
}

// ---- AGENTS.md draft (§9.7) -----------------------------------------------------------------

export function agentsMdPrompt(i: { projectName: string; stack: StackInfo; tree: string }): string {
  return `Do not change any files. Explore this repository and draft a concise AGENTS.md for AI coding agents working on it.

${section('Goal', `Draft AGENTS.md for ${i.projectName}`)}${section('Detected stack', i.stack.kinds.join(', ') || 'unknown')}${section('File tree (depth 2)', '```\n' + i.tree + '\n```')}## Instructions
Cover: stack, how to build / test / run, project structure, coding conventions, and things to avoid. Be concise (under ~150 lines) and specific to this repository — verify commands by reading package/build files.
Reply with ONLY the Markdown content of the file (no surrounding commentary, no code fence around the whole file).
`;
}

export function cleanMarkdownReply(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1] : t).trim() + '\n';
}

// ---- structured output parsing (§9.4, §9.6) -------------------------------------------------

/** Last ```json block, else first `{` … last `}`. */
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { return JSON.parse(blocks[i][1]); } catch { /* try the next one */ }
  }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error('no JSON found');
}

const TYPES: TaskType[] = ['implement', 'refactor', 'ui', 'tests', 'small-fix', 'analysis', 'docs', 'architecture'];
const SIZES: TaskSize[] = ['small', 'medium', 'large'];

export interface PlannedTask {
  key: string; title: string; description: string; type: TaskType; size: TaskSize; dependsOn: string[];
  suggestedProvider: 'claude' | 'codex' | 'gemini' | null;
}
export interface Plan { summary: string; tasks: PlannedTask[] }

export function parsePlan(text: string): Plan {
  const raw = extractJson(text) as any;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) throw new Error('plan JSON must have a "tasks" array');
  if (raw.tasks.length === 0) throw new Error('plan has no tasks');
  if (raw.tasks.length > 8) raw.tasks = raw.tasks.slice(0, 8);
  const keys = new Set<string>();
  const tasks: PlannedTask[] = raw.tasks.map((t: any, i: number) => {
    const key = String(t?.key ?? `t${i + 1}`).trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || `t${i + 1}`;
    if (keys.has(key)) throw new Error(`duplicate task key ${key}`);
    keys.add(key);
    const sp = t?.suggestedProvider;
    return {
      key,
      title: String(t?.title ?? `Task ${key}`).slice(0, 200),
      description: String(t?.description ?? t?.title ?? ''),
      type: TYPES.includes(t?.type) ? t.type : 'implement',
      size: SIZES.includes(t?.size) ? t.size : 'medium',
      dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.map(String) : [],
      suggestedProvider: sp === 'claude' || sp === 'codex' || sp === 'gemini' ? sp : null,
    };
  });
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!keys.has(d)) throw new Error(`task ${t.key} depends on unknown task ${d}`);
      if (d === t.key) throw new Error(`task ${t.key} depends on itself`);
    }
  }
  topoSort(tasks);
  return { summary: String(raw.summary ?? ''), tasks };
}

/** Kahn's algorithm; throws on cycles. Returns keys in dependency order. */
export function topoSort(tasks: Array<{ key: string; dependsOn: string[] }>): string[] {
  const indeg = new Map(tasks.map((t) => [t.key, t.dependsOn.length]));
  const out: string[] = [];
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.key);
  while (queue.length) {
    const k = queue.shift()!;
    out.push(k);
    for (const t of tasks) {
      if (t.dependsOn.includes(k)) {
        indeg.set(t.key, indeg.get(t.key)! - 1);
        if (indeg.get(t.key) === 0) queue.push(t.key);
      }
    }
  }
  if (out.length !== tasks.length) throw new Error('plan has a dependency cycle');
  return out;
}

export function parseReview(text: string): Omit<ReviewResult, 'reviewer'> {
  try {
    const raw = extractJson(text) as any;
    const critical = Array.isArray(raw?.critical) ? raw.critical.map(String).filter(Boolean) : [];
    const notes = Array.isArray(raw?.notes) ? raw.notes.map(String).filter(Boolean) : [];
    let verdict: 'approve' | 'changes' = raw?.verdict === 'changes' ? 'changes' : 'approve';
    if (raw?.verdict !== 'approve' && raw?.verdict !== 'changes') throw new Error('missing verdict');
    if (critical.length && verdict === 'approve') verdict = 'changes';
    return { verdict, critical, notes };
  } catch {
    return { verdict: 'approve', critical: [], notes: [`Reviewer output could not be parsed: ${text.slice(0, 500)}`], parseFailed: true };
  }
}
