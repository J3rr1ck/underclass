# Changelog

Entries state what was verified, not what was intended. Retractions are recorded,
not deleted — see "How this repo gets measurement wrong" in `CLAUDE.md` for why.

## 0.1.0-alpha.1 — 2026-08-07

First alpha. Two binaries from one package:

- **`under`** — a local-first coding agent on the pi SDK. Tiered model routing
  (`tiny`/`normal`/`thinking`, plus a `planning` role), plan-then-execute,
  fan-out across git worktrees, scripted workflows with content-addressed
  resume, telemetry to `~/.underclass/runs.jsonl`, `doctor`/`setup`/`learn`/
  `stats` subcommands, and an OpenRouter free-tier mode (`--free`).
- **`danger`** — zsh with help when you need it: Tab-on-prose completion,
  install hints on command-not-found, one-line hints after failures, and
  `danger why` to explain the last failure. A plugin, not a shell; one line to
  install, one to remove.

Plus a 40-task cross-agent benchmark (`bench/`), a SWE-bench harness, and the
measurement harnesses that keep both honest.

### Fixed in the run-up to this alpha (all with regression tests that were
verified to fail against the unfixed tree)

- `danger why` explained the string "danger why" instead of the failed command —
  it had presumably never worked in an installed shell — and its re-run guard
  approved `npm test; ./deploy.sh` because zsh rewrites `;` lists into newlines
  that the blacklist could not see. Fixed together; fixing only the first arms
  the second.
- `under fan-out` from a fan-out child could recurse without bound (4 → 16 → 64
  agents). Depth is now a counter with a ceiling (`UNDER_FANOUT_MAX_DEPTH`).
- A branch named in Cyrillic/CJK/emoji slugged to `""`, collapsing its worktree
  onto the worktrees directory: sibling work was committed as a gitlink onto the
  user's branch and cleanup deleted preserved worktrees. Hash fallback + path
  containment assertion.
- A workflow agent whose commit failed (an ordinary pre-commit hook, a missing
  committer identity) had its work force-deleted and was recorded `ok`; resume
  then replayed the false success forever. Commit failure is now agent failure,
  the worktree is preserved and named in the report.
- Fan-out judged emptiness from the branch ref, so an agent that ran
  `git checkout -b` had its work destroyed and reported as "no changes". Judged
  from the worktree's HEAD now; misplaced work is preserved and named.
- `batch_edit` grouped edits by path *string*, so `a.txt` + `./a.txt` became two
  whole-file rewrites and the last write clobbered the first. Groups by
  `statSync` dev:ino (`realpathSync` does not case-fold on macOS).
- `line_anchored_edit`'s whitespace-tolerant fallback replaced the matched line
  verbatim, destroying the indentation it existed to tolerate (Python
  IndentationError, Makefile "missing separator", YAML re-parenting). The
  matched line's indentation is re-applied; the hash anchor form dedents.
- Every `--ollama` run was declared an 8192-token context window, which pi's
  clamp turns into `max_completion_tokens: 1` — one token out, no tool calls,
  recorded as success. Ollama's real window is read from `/api/ps`, and a
  window too small to generate is refused before the first request.
- `workflow --list` executed the script header (`new Function`) — arbitrary code
  execution from listing a repo's workflows. Replaced with a non-evaluating
  literal parser.

### Known issues (tracked, honestly)

- 12 further review findings are open in `KNOWN-ISSUES.md` in this repository — re-verified
  against this exact tree on 2026-08-07 by 12 independent agents with executed
  repros: **all 12 are real** (7 high, 5 medium; none critical). The sharpest,
  A5: against an endpoint that reports no context window, the shipped default
  leaves a ~151-token generation budget and the run does nothing while exiting
  0 — the guided `under setup` path (LM Studio/Ollama) discovers real windows
  and is not affected; bare `--base-url` endpoints are. Notables: structured-output extraction can drop a JSON answer after
  an unbalanced brace in prose (W2/W5); piped multi-line stdin runs only the
  first line (A2); `under learn` can install a fictional `servedContext` (T3).
- The `danger` bin name collides with danger-js on npm (1.3M weekly downloads).
  This package is not published to npm — the installer serves a prebuilt
  tarball from permanent.sh — and the name question stays open until it is.
  The installer warns before shadowing an existing `danger` command.
- `api.danger.plus` has no authentication (`SECURITY.md`, P5-1). This alpha is
  local-first: point `under` at your own endpoints.
- The archived benchmark numbers predate two invalidating bugs and carry no
  provenance; do not quote them. A re-run is the gate for any published claim.

License: AGPL-3.0-only.
