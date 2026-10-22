# Ensemble

A local multi-AI coding orchestrator. It drives **Claude Code**, **OpenAI Codex CLI** and **Gemini CLI** as one team on an existing local git repository, using your existing subscription logins (no API keys).

You type a goal. A lead model plans subtasks, each subtask runs in its own **git worktree** in parallel, your project's tests run, a **different provider** reviews each diff, and you approve each merge. Everything streams live to a web dashboard that also works on your phone over Tailscale. Nothing is ever pushed.

> ⚠️ **Check your employer's policy before using this on work code.** Ensemble sends your code to whichever AI CLIs you have logged in.

## 1. Prerequisites

- Node.js 22+, pnpm, git
- Each CLI you want to use, installed **and logged in once interactively**:
  - `claude` (Claude Code) — run `claude` once and sign in
  - `codex` (OpenAI Codex CLI) — run `codex` once and sign in
  - **Gemini via Antigravity CLI** (`agy`), Google's replacement for Gemini CLI. Gemini CLI stopped serving personal Google accounts (AI Pro/Ultra/free) on 2026-06-18. Install it, then run `~/.local/bin/agy` once and choose **Google OAuth**:
    ```bash
    curl -fsSL https://antigravity.google/cli/install.sh | bash
    ```
    With a Gemini Code Assist licence or a paid API key you can keep the legacy `gemini` CLI instead: Settings → Gemini → Command-line tool.

Missing or disabled CLIs are skipped by the router. One installed CLI is enough; reviews then fall back to self-review with a different model (flagged in the UI).

## 2. Run it

```bash
pnpm i && pnpm start
```

Open <http://127.0.0.1:4317>. Config lives in `~/.ensemble/config.json` (created on first start, editable in **Settings**).

Try it without spending quota (all three providers are simulated, including cross-provider review and limit handoffs; data goes to `~/.ensemble-demo`):

```bash
pnpm demo
```

Other scripts: `pnpm test` (vitest), `pnpm typecheck`, `pnpm dev` (server watch + Vite on :5173), `pnpm smoke` (see below).

Env overrides: `PORT`, `ENSEMBLE_HOST`, `ENSEMBLE_HOME`, `ENSEMBLE_DEMO=1`, `ENSEMBLE_TOKEN`, `ENSEMBLE_ALLOWED_HOSTS` (extra Host/Origin names, comma-separated), `ENSEMBLE_PUBLIC_URL` (base URL used in push-notification links).

## 3. Phone access (Tailscale)

1. Install Tailscale on the Mac and the iPhone, and sign in with the same account on both.
2. On the Mac: `tailscale serve --bg 4317`
3. Open the printed `https://<mac-name>.<tailnet>.ts.net` URL on the phone → Share → **Add to Home Screen**.

The server itself only listens on `127.0.0.1`; `tailscale serve` provides HTTPS that only your tailnet can reach. If you bind `host` to anything else, you must set `ENSEMBLE_TOKEN` (enter it under Settings → Access token in each browser).

## 4. Push notifications (optional, ntfy)

Install the ntfy app on your phone, subscribe to a hard-to-guess topic (e.g. `ensemble-7f3k2q`), and put the same topic in Settings → ntfy topic, then click **Send test notification**. You'll get pushes for "Task ready for review", usage limits, and finished runs even when the dashboard is closed. Set `ENSEMBLE_PUBLIC_URL` to your `ts.net` URL so taps open the right run.

## 5. A shared AGENTS.md

All three CLIs read project instructions: Claude reads `CLAUDE.md`, Gemini reads `GEMINI.md`, Codex reads `AGENTS.md`. Keep one file and symlink the others:

```bash
ln -s AGENTS.md CLAUDE.md
```

```bash
ln -s AGENTS.md GEMINI.md
```

Or click **Draft AGENTS.md** on the project page. The lead model drafts one read-only, you edit it, and **Save** writes it. Tick "Symlink CLAUDE.md and GEMINI.md" to create the aliases; existing files are never overwritten.

## 6. Permissions per CLI

Agents always work in isolated worktrees under `~/.ensemble/worktrees`, never in your checkout. Defaults are the safer modes:

| CLI | work / fix | planning / review (read-only) |
|---|---|---|
| Claude | `--permission-mode acceptEdits` (edits files, no arbitrary shell) | `--permission-mode plan` |
| Codex | `--sandbox workspace-write` | `--sandbox read-only` |
| Gemini (Antigravity `agy`, default) | `--mode accept-edits` | `--mode plan` |
| Gemini (legacy `gemini` CLI) | `--approval-mode auto_edit --skip-trust` | `--approval-mode plan --skip-trust` |

To give agents more autonomy, add flags under Settings → Providers → **Extra args** (appended to every call):

- Claude, allow builds: `--allowedTools "Bash(npm *)" "Bash(pnpm *)" "Bash(dotnet *)"`
- Claude, full autonomy (opt-in only): `--dangerously-skip-permissions`
- Codex, full autonomy (opt-in only, no sandbox): `--dangerously-bypass-approvals-and-sandbox`
- Gemini via Antigravity: shell commands are denied in headless mode unless allowed. Add rules to `~/.gemini/antigravity-cli/settings.json`, e.g. `{"permissions": {"allow": ["command(npm)", "command(pnpm)"]}}`. For full autonomy (opt-in only), add `--dangerously-skip-permissions` to Extra args. If Antigravity ends a turn empty after a denied command, Ensemble resumes that conversation once and asks it to continue with file tools.
- Gemini via legacy CLI: `--yolo`

Gemini's `--skip-trust` trusts each task worktree for that one invocation only, so headless runs don't abort in a new folder. It doesn't add the folder to Gemini's trusted list. Flags were verified against claude 2.1.296, codex-cli 0.163, agy 1.4.5 and gemini 0.65. After a CLI update, run `pnpm smoke` (or `pnpm smoke codex`). It runs a tiny read-only prompt and prints the normalized events, so you can confirm the parsers still match.

## 7. Keep the Mac awake and online

Agents run on your Mac. While agents are working, Ensemble runs `caffeinate -i` (toggle in Settings), but the Mac must stay powered and online, with the lid open or on power with an external display. To start Ensemble at login:

```bash
scripts/install-launchagent.sh
```

(`scripts/install-launchagent.sh remove` to uninstall; logs go to `~/.ensemble/logs/server.log`.)

## How it works

- **Plan → build → test → review → approve.** The lead (default `claude/opus`) returns a JSON plan of 1–8 tasks with dependencies. Each task gets a worktree on branch `ensemble/<run>/<task>` from the run's base commit, with dependency branches merged in. After the agent finishes, Ensemble commits, runs your test command (with up to `maxTestRetries` fix rounds), then asks a different provider to review. Critical issues trigger one fix round (`maxReviewFixRounds`). You then **Approve & merge** (`git merge --no-ff` into the base branch; the main tree must be clean), **Reject**, **Retry with feedback**, or **Reassign**.
- **Routing.** Per-task-type preference lists live in Settings. With `learnRouting`, outcomes (first-try pass rate, critical issues) reorder candidates once each has ≥ 5 results; usage headroom breaks ties.
- **Usage limits.** Limit errors are detected from CLI output. With `onLimit: "handoff"` (default), WIP is committed and another provider continues. With `"wait"`, the task waits for the reset and resumes the same session.
- **Restarts.** In-flight tasks are marked failed ("interrupted by restart"), and their worktree contents are kept. Click Retry.
