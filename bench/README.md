# Benchmark: Claude Code vs Ensemble

A mid-complexity task for comparing a single Claude Code session with an Ensemble run on the same starting repo.

**The task** ([PROMPT.md](PROMPT.md)): turn `bookshelf` (a tiny Node library + CLI) into a usable catalogue, adding:
- validation, plus a new `update()`
- search with filters, sorting and pagination
- atomic, versioned file storage with legacy migration
- RFC 4180 CSV import/export
- a rewritten CLI
- tests and docs

That's about 5 modules. Most can be built in parallel, and the CLI depends on the storage and CSV modules. That shape is what Ensemble is meant for, while staying small enough for one Claude Code session to finish.

**Scoring** is objective: 34 hidden acceptance tests that neither tool sees. The untouched starter repo scores 2/34, and a correct solution scores 34/34 (both checked). The tests follow the API in the prompt exactly, and nothing depends on wording or implementation details.

## 1. Set up

```bash
bench/setup.sh
```

This creates two identical repos at the same commit under `~/Projects/ensemble-bench`, one in `claude-code/bookshelf` and one in `ensemble/bookshelf`, and copies the prompt to `PROMPT.md` next to them. Pass another folder as the first argument if you like. For Ensemble, the folder must be under an allowed root (Settings → Folders).

## 2. Run both

**Claude Code**: `cd ~/Projects/ensemble-bench/claude-code/bookshelf && claude`, paste the whole of `PROMPT.md`, and let it work. Approve its permission prompts as they come, so `npm test` runs too. Don't add hints.

**Ensemble**: open the dashboard, open `~/Projects/ensemble-bench/ensemble/bookshelf`, check the test command is `npm test`, paste the same prompt, and click **Start run**. Approve each task you'd honestly merge; reject or retry the rest as you normally would, and count each one as an intervention.

## 3. Score

```bash
bench/score.sh ~/Projects/ensemble-bench/claude-code/bookshelf
```

```bash
bench/score.sh ~/Projects/ensemble-bench/ensemble/bookshelf
```

`score.sh` scores a scratch copy of each repo's working tree, so uncommitted Claude Code edits count and the originals are never touched. It runs the repo's own `npm test`, then the hidden acceptance tests, broken down by area (validation, search, persist, csv, cli), and lists every failure.

## Keeping it fair

- **Same starting point.** `setup.sh` gives both repos the same commit hash.
- **Same prompt, pasted verbatim.** No follow-up hints. If you nudge one tool, count it as an intervention.
- **Comparable models.** Ensemble plans with Claude Opus and routes work to Codex, Claude Sonnet and Gemini by default. For a "same brain" comparison, run Claude Code on Opus. For a "team vs solo" comparison, keep Ensemble's defaults.
- **Similar permissions.** By default Ensemble's agents can't run shell commands, but Ensemble runs `npm test` itself and feeds failures back. Claude Code will ask to run `npm test`; allow it.
- **Don't let either tool see `bench/acceptance/`.** Keep the benchmark repos outside the Ensemble folder (the default location already is).
- **Run it more than once** if you can. Agent runs vary, and two or three runs each tell you much more than one.

## Scorecard

| | Claude Code | Ensemble |
|---|---|---|
| Hidden acceptance tests (x / 34) | | |
| …validation / search / persist / csv / cli | | |
| Repo's own tests pass? | | |
| Wall-clock time (prompt → done) | | |
| Your interventions (nudges, retries, rejects) | | |
| Quota used¹ | | |
| Code quality (your read of the diff, 1–5) | | |
| README quality (1–5) | | |

¹ Claude Code: `/cost` or `/usage` at the end. Ensemble: Settings → provider cards (runs and tokens in the last 5 hours), and the token totals in each task's feed. Ensemble spends across several subscriptions, so note each provider separately.

**What to look for beyond the number:** did review catch real bugs (see each task's reviewer notes)? Did parallel tasks conflict when merging? How much attention did each tool need from you? Is one faster but sloppier?
