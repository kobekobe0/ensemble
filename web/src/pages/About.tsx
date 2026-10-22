import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ProviderStrip } from '../components/ProviderStrip';
import { navigate, useStore } from '../store';

const SECTIONS: Array<{ id: string; title: string }> = [
  { id: 'what', title: 'What Ensemble does' },
  { id: 'quickstart', title: 'Quick start' },
  { id: 'providers', title: 'Setting up the AI CLIs' },
  { id: 'run', title: 'Running a goal' },
  { id: 'review', title: 'Reviewing and merging' },
  { id: 'statuses', title: 'Task statuses' },
  { id: 'routing', title: 'Routing: who does what' },
  { id: 'limits', title: 'Usage limits' },
  { id: 'permissions', title: 'Permissions and autonomy' },
  { id: 'agents-md', title: 'AGENTS.md' },
  { id: 'phone', title: 'Phone access and notifications' },
  { id: 'goals', title: 'Writing good goals' },
  { id: 'troubleshooting', title: 'Troubleshooting' },
  { id: 'safety', title: 'Safety notes' },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="card about-section">
      <h2>{title}</h2>
      <div className="about-body">{children}</div>
    </section>
  );
}

const Cmd = ({ children }: { children: string }) => <pre className="about-cmd"><code>{children}</code></pre>;

export function AboutPage() {
  const demo = useStore((s) => s.demo);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { api.health().then((h) => setVersion(h.version)).catch(() => {}); }, []);
  const link = (to: string, text: string) => <a href={to} onClick={(e) => { e.preventDefault(); navigate(to); }}>{text}</a>;

  return (
    <div className="page narrow about">
      <div className="card">
        <div className="spread" style={{ flexWrap: 'wrap' }}>
          <h1>About Ensemble</h1>
          <span className="small dim">{version ? `v${version}` : ''}{demo ? ' · demo mode' : ''}</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A local orchestrator that runs <strong>Claude Code</strong>, <strong>Codex</strong> and <strong>Gemini</strong> (through Antigravity) as one team on your git repositories, using the subscriptions you're already signed in to.
        </p>
        <nav className="about-toc" aria-label="Contents">
          {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{s.title}</a>)}
        </nav>
      </div>

      <Section id="what" title="What Ensemble does">
        <ol>
          <li><strong>Plan.</strong> A lead model reads your repo and splits your goal into 1–8 tasks, with dependencies where one task needs another's changes.</li>
          <li><strong>Build in parallel.</strong> Each task gets its own <code>git worktree</code> and branch (<code>ensemble/&lt;run&gt;/&lt;task&gt;</code>), and the best-suited provider works on it. Your own checkout is never touched while agents work.</li>
          <li><strong>Test.</strong> Your project's test command runs in each worktree. If it fails, the author gets a chance to fix it (2 tries by default).</li>
          <li><strong>Cross-review.</strong> A <em>different</em> provider reviews the diff. Critical issues send it back for one fix round.</li>
          <li><strong>You approve.</strong> Nothing merges until you click <em>Approve &amp; merge</em>, and nothing is ever pushed.</li>
        </ol>
        <p className="muted">Everything streams live here and is stored locally, so you can close the tab and come back to any run, including from your phone.</p>
      </Section>

      <Section id="quickstart" title="Quick start">
        <ol>
          <li>Start the server in the Ensemble folder:<Cmd>pnpm i && pnpm start</Cmd></li>
          <li>On {link('/', 'Projects')}, browse to a git repo or paste its path. Projects stay where they are on disk.</li>
          <li>Check the <strong>test command</strong> on the project card (it's detected for Node, .NET, Flutter, Go, Rust and Python).</li>
          <li>Type a goal, click <strong>Start run</strong>, and watch the run page.</li>
          <li>Approve or reject each task in <strong>Ready for review</strong>.</li>
        </ol>
        <p>Want to try it without spending quota? <code>pnpm demo</code> simulates all three providers, including reviews, test failures and usage-limit handoffs.</p>
      </Section>

      <Section id="providers" title="Setting up the AI CLIs">
        <p>Each CLI must be installed and <strong>signed in once interactively</strong>. Ensemble then runs it headless with your login.</p>
        <ProviderStrip controls={false} />
        <table className="data about-table">
          <thead><tr><th>Provider</th><th>Install</th><th>Sign in once</th></tr></thead>
          <tbody>
            <tr><td><span className="prov claude">Claude</span></td><td><code>npm i -g @anthropic-ai/claude-code</code></td><td><code>claude</code> → log in</td></tr>
            <tr><td><span className="prov codex">Codex</span></td><td><code>npm i -g @openai/codex</code></td><td><code>codex login</code></td></tr>
            <tr><td><span className="prov gemini">Gemini</span></td><td><code>curl -fsSL https://antigravity.google/cli/install.sh | bash</code></td><td><code>~/.local/bin/agy</code> → Google OAuth</td></tr>
          </tbody>
        </table>
        <div className="banner info">
          Google stopped serving personal accounts through <strong>Gemini CLI</strong> on June 18, 2026, so Ensemble's Gemini provider uses the <strong>Antigravity CLI (<code>agy</code>)</strong> by default. With a Gemini Code Assist licence or a paid API key you can switch back under {link('/settings', 'Settings')} → Gemini → Command-line tool.
        </div>
        <p>After a CLI updates, run <code>pnpm smoke</code> (or <code>pnpm smoke codex</code>). It sends a tiny read-only prompt and prints how Ensemble understood the output, so a changed output format shows up immediately.</p>
        <p>Missing or disabled providers are skipped. One working provider is enough. Reviews then fall back to <em>self-review</em> with a different model, flagged in the UI.</p>
      </Section>

      <Section id="run" title="Running a goal">
        <ul>
          <li><strong>Lead</strong>: which model plans. The default is Claude Opus. If it's limited, the next provider in the plan routing list takes over.</li>
          <li><strong>Review plan before starting</strong>: pauses after planning so you can edit titles, descriptions, provider/model and dependencies, then click <em>Start run</em>.</li>
          <li><strong>The run page</strong> shows the task graph (click a task to follow it), a live feed per active task (on phones they become tabs), and the review queue.</li>
          <li><strong>Pause</strong> stops new tasks from starting while running ones finish. <strong>Stop</strong> aborts every agent, and work done so far stays in the worktrees.</li>
          <li><strong>Uncommitted changes</strong> in your checkout are allowed, but agents start from the last commit and won't see them.</li>
          <li>The feed hides raw logs by default. Tick <strong>logs</strong> under a feed to see CLI output and test output line by line.</li>
        </ul>
      </Section>

      <Section id="review" title="Reviewing and merging">
        <ul>
          <li><strong>Approve &amp; merge</strong> runs <code>git merge --no-ff</code> of the task branch into the branch the run started from. Your checkout must be on that branch and <em>completely clean</em> (untracked files count). Commit or stash first.</li>
          <li><strong>Merge conflict?</strong> The merge is aborted automatically and nothing changes. Use <strong>Rebase onto current branch</strong> to rebuild the task on top of your latest commit and re-run tests and review.</li>
          <li><strong>Reject</strong> takes an optional reason. If you then click <strong>Retry with feedback</strong>, the reason is passed to the agent.</li>
          <li><strong>Reassign</strong> retries the task with another provider or model. Retrying resets the worktree to the run's base commit.</li>
          <li><strong>Clean up branches</strong> (on finished runs) deletes merged <code>ensemble/…</code> branches. Branches of failed or rejected tasks are removed automatically when the run finishes.</li>
          <li>Badges: <span className="status s-waiting_limit">self-review</span> means no other provider was available, and <span className="status s-waiting_limit">⚠ review unparsed</span> means the reviewer's answer wasn't valid JSON, so read the notes yourself.</li>
        </ul>
      </Section>

      <Section id="statuses" title="Task statuses">
        <table className="data about-table">
          <tbody>
            {([
              ['pending', 'Waiting for dependencies or a free slot (max parallel / per-provider caps).'],
              ['running', 'The agent is working in its worktree.'],
              ['testing', 'Your test command is running.'],
              ['fixing', 'The author is fixing failing tests or critical review issues.'],
              ['reviewing', 'Another provider is reviewing the diff.'],
              ['waiting_limit', 'The provider hit its usage limit; the task resumes after the reset.'],
              ['awaiting_approval', 'Ready for you. Dependent tasks may already build on it.'],
              ['merged', 'Merged into your branch.'],
              ['no_changes', 'The agent decided nothing needed changing.'],
              ['rejected / failed / stopped', 'Not merged. Retry or reassign at any time.'],
            ] as const).map(([s, d]) => <tr key={s}><td className="nowrap"><span className={`status s-${s.split(' ')[0]}`}>{s.replace(/_/g, ' ')}</span></td><td>{d}</td></tr>)}
          </tbody>
        </table>
        <p className="muted">A run finishes when every task has a final status (merged, rejected, no changes, failed or stopped). If the server restarts mid-run, interrupted tasks show <em>failed — interrupted by restart</em>, and Retry picks them up again.</p>
      </Section>

      <Section id="routing" title="Routing: who does what">
        <p>Each task type has an ordered preference list in {link('/settings', 'Settings → Routing')}:</p>
        <table className="data about-table">
          <tbody>
            <tr><td>plan, architecture</td><td>Claude Opus → Codex → Gemini</td></tr>
            <tr><td>implement, tests</td><td>Codex → Claude Sonnet → Gemini</td></tr>
            <tr><td>refactor, ui</td><td>Claude Sonnet → Codex → Gemini</td></tr>
            <tr><td>small-fix</td><td>Claude Haiku → Gemini → Codex</td></tr>
            <tr><td>analysis, docs</td><td>Gemini → Claude → Codex</td></tr>
            <tr><td>review</td><td>Claude Sonnet → Codex → Gemini (never the author's provider)</td></tr>
          </tbody>
        </table>
        <ul>
          <li>An empty model field means "use that CLI's default model".</li>
          <li>With <strong>Learn from outcomes</strong> on, once two candidates each have ≥ 5 results for a task type, they're re-ranked by first-try test pass rate minus critical review issues. See <em>Routing stats</em> in Settings.</li>
          <li>Near-ties go to the provider with more headroom in its 5-hour window, and large tasks skip fast models (haiku / flash / mini).</li>
        </ul>
      </Section>

      <Section id="limits" title="Usage limits">
        <ul>
          <li>Usage bars are <strong>estimates</strong>: agent runs in the last 5 hours ÷ the budget you set per provider. The CLIs don't report your remaining quota.</li>
          <li>When a CLI reports a limit, Ensemble records the reset time (or uses your cooldown), shows <span className="status s-waiting_limit">limited until …</span>, and notifies you.</li>
          <li><strong>Hand off</strong> (default): the work so far is committed as <code>WIP</code> and another provider continues from it. <strong>Wait</strong>: the task pauses and resumes the same session after the reset.</li>
          <li>Use <em>Mark as limited until…</em> on a provider card to steer work away from a provider manually.</li>
        </ul>
      </Section>

      <Section id="permissions" title="Permissions and autonomy">
        <p>Agents only ever work in worktrees under <code>~/.ensemble/worktrees</code>. The defaults are the safer modes:</p>
        <table className="data about-table">
          <thead><tr><th>CLI</th><th>Work / fix</th><th>Plan / review</th></tr></thead>
          <tbody>
            <tr><td>Claude</td><td><code>--permission-mode acceptEdits</code> (edits, no shell)</td><td><code>--permission-mode plan</code></td></tr>
            <tr><td>Codex</td><td><code>--sandbox workspace-write</code></td><td><code>--sandbox read-only</code></td></tr>
            <tr><td>Gemini (agy)</td><td><code>--mode accept-edits</code> (shell denied)</td><td><code>--mode plan</code></td></tr>
          </tbody>
        </table>
        <p>To let agents run builds themselves, add flags under Settings → Providers → <strong>Extra args</strong>:</p>
        <ul>
          <li>Claude: <code>--allowedTools "Bash(npm *)" "Bash(pnpm *)"</code></li>
          <li>Antigravity: allow rules in <code>~/.gemini/antigravity-cli/settings.json</code>, e.g. <code>{`{"permissions":{"allow":["command(npm)"]}}`}</code></li>
          <li>Full autonomy (opt-in, at your own risk): <code>--dangerously-skip-permissions</code> (Claude, agy) or <code>--dangerously-bypass-approvals-and-sandbox</code> (Codex).</li>
        </ul>
        <p className="muted">Your test command still runs either way, because Ensemble runs it, not the agent.</p>
      </Section>

      <Section id="agents-md" title="AGENTS.md">
        <p>One instructions file for all three agents: stack, how to build and test, conventions, things to avoid. On the project page, click <strong>Draft AGENTS.md</strong>. The lead model drafts it read-only, you edit it, and <em>Save</em> writes it. Tick the option to symlink <code>CLAUDE.md</code> and <code>GEMINI.md</code> to it; existing files are never overwritten.</p>
        <p className="muted">It's the cheapest quality boost you can give the agents. Every prompt tells them to read it first, and reviewers check changes against it.</p>
      </Section>

      <Section id="phone" title="Phone access and notifications">
        <ol>
          <li>Install Tailscale on the Mac and the phone, signed in to the same account.</li>
          <li>On the Mac:<Cmd>tailscale serve --bg 4317</Cmd></li>
          <li>Open the printed <code>https://&lt;mac&gt;.&lt;tailnet&gt;.ts.net</code> URL on the phone, then <strong>Share → Add to Home Screen</strong>.</li>
        </ol>
        <p><strong>Push notifications</strong>: install the ntfy app, subscribe to a hard-to-guess topic, enter the same topic in Settings and click <em>Send test notification</em>. You'll be pinged when a task is ready for review, a provider is limited, or a run finishes.</p>
        <p className="muted">The server only listens on 127.0.0.1. Tailscale is what makes it reachable, and only from your own devices.</p>
      </Section>

      <Section id="goals" title="Writing good goals">
        <ul>
          <li><strong>Say what "done" looks like.</strong> Name the behaviour, edge cases and files you expect, e.g. "returns 400 for missing fields; covered by tests".</li>
          <li><strong>Make work separable.</strong> Ensemble shines when a goal has parts that can run in parallel (feature + tests + docs, or two independent features). A one-line fix is one task, and that's fine.</li>
          <li><strong>Keep a working test command.</strong> It's the main signal for fix rounds and for routing stats.</li>
          <li><strong>Commit before starting.</strong> Agents start from your last commit.</li>
          <li><strong>Use Review plan</strong> for bigger goals: merging two tasks that touch the same lines prevents conflicts later.</li>
          <li>Tasks that touch the same lines of the same file should be one task or depend on each other. Otherwise the second merge may conflict, and you'll need Rebase.</li>
        </ul>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <dl className="about-faq">
          <dt>A provider shows "not installed"</dt>
          <dd>Set an absolute path under Settings → Providers → Binary, or click <em>Re-check installed CLIs</em>. Ensemble also looks in <code>~/.local/bin</code>, <code>/opt/homebrew/bin</code> and your login shell's PATH.</dd>
          <dt>"Merge refused: uncommitted changes"</dt>
          <dd>Your checkout must be clean, including untracked files. Commit or stash, then approve again.</dd>
          <dt>Every task fails right away</dt>
          <dd>Open the task feed with <em>logs</em> ticked. Usually the CLI isn't signed in (run it interactively once), or a flag changed after an update (run <code>pnpm smoke</code>).</dd>
          <dt>Gemini says "This client is no longer supported"</dt>
          <dd>That's the legacy Gemini CLI on a personal account. Switch Settings → Gemini → Command-line tool to Antigravity.</dd>
          <dt>Antigravity ends with an empty reply</dt>
          <dd>It tried a shell command that headless mode denies. Ensemble nudges it once to continue with file tools. Add allow rules (see Permissions) if your tasks need commands.</dd>
          <dt>Tests pass locally but fail in Ensemble</dt>
          <dd>Worktrees share your <code>node_modules</code> through a symlink. Other stacks may need a setup command (e.g. <code>dotnet restore</code>) on the project card. Tests run with <code>CI=1</code>.</dd>
          <dt>The dashboard says "Reconnecting…"</dt>
          <dd>The server stopped or the Mac went to sleep. Events are stored, so the page catches up as soon as it reconnects.</dd>
        </dl>
      </Section>

      <Section id="safety" title="Safety notes">
        <ul>
          <li><strong>Check your employer's policy</strong> before using this on work code. Your code is sent to whichever AI providers you've enabled.</li>
          <li>Nothing is pushed, and nothing merges without your click. Agents can't change branches or commit, because Ensemble does all git work.</li>
          <li>Each run uses real subscription quota on every provider involved: planning + work + fixes + review.</li>
          <li>Data lives in <code>~/.ensemble</code> (config, SQLite history, worktrees). Deleting a run removes its worktrees and unmerged branches.</li>
          <li>The Mac has to stay awake and online. Ensemble keeps it awake while agents run (toggle in Settings).</li>
        </ul>
      </Section>
    </div>
  );
}
