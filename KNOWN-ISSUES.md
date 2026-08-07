# Known issues

Independently re-verified with executed reproductions on 2026-08-07, one agent
per finding, against the exact tree this alpha shipped from. All twelve are
real. Listed by name because an alpha that hides its issues teaches its users
to distrust the parts that work.

| id | sev | what happens |
|---|---|---|
| A5 | high | Against an endpoint that reports no context window, the default tool registration leaves a ~151-token generation budget: the run does nothing and exits 0. The guided `under setup` path (LM Studio/Ollama) discovers real windows and is unaffected; bare `--base-url` endpoints are exposed. |
| W2 | high | Structured-output extraction abandons its scan after an unbalanced `{` or `[` quoted in prose, losing (or worse, mis-picking) the model's actual JSON answer. |
| W5 | high | A workflow schema without `required` can have a correct answer coerced to `{}` and reported `ok`, with zero retries. |
| A1 | high | The silent-no-op detector disarms itself when the endpoint omits usage fields, so a run that did nothing exits 0. |
| T4 | high | `repo_search` reports "No matches found" when ripgrep failed to run at all, briefly caches the lie, and a failed nested lookup can return definitions as call sites. |
| A3 | high | The planner's investigation-step filter can delete actionable steps, then tell the executor not to skip steps. |
| A2 | high | Piped multi-line stdin runs only the first line, silently discards the rest, exits 0. |
| T3 | med | `under learn --apply` can write a fictional `servedContext` derived from "largest prompt that succeeded", which then ratchets downward. Avoid `--apply` for now. |
| T12 | med | A cloned repo's `.underclass/preferences.md` enters the system prompt uncapped — treat cloned preference files as untrusted until this is gated. |
| D4 | med | With a corrupted (orphaned) install marker, `danger init`/`danger uninstall-shell` can delete an unbounded span of `~/.zshrc` with no backup. The markers are only ever written in pairs; the trigger requires an out-of-band edit. |
| G6 | med | Child output beyond 64 KiB can corrupt multibyte characters in workflow answers (chunk-boundary decoding). |
| W9 | med | An isolated workflow agent that answers nothing (dead endpoint) can be recorded `ok` and replayed by `--resume`. |

Fix order and pairings (A5+A1 must land together; W2+W5 must land together) are
part of the verification record. If you hit one of these, an issue with a
reproduction is very welcome.
