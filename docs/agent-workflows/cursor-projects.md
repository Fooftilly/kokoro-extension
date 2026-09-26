# Cursor Projects workflow (kokoro-extension)

Simplified PRKS-style operating model for this repository.

## Model

- **One long-lived Project** owns the engineering uplift and follow-on work for this repo.
- **GitHub issues are the source of truth** for bugs and engineering tasks (`#4`–`#8` today, plus future issues).
- **One bounded deliverable per worker** (for example: Stage 1 foundation, or a single bug-fix PR). Do not ask one worker to own unrelated subsystems in the same turn.
- **Avoid parallel agents on the same subsystem** (for example two agents editing `popup.js` / voice fetching at once). Serialize conflicting work; parallelize only across clearly disjoint areas after Stage 1 lands.

## Worker task packet (required fields)

When assigning a worker, include:

| Field | Meaning |
| --- | --- |
| **Goal** | One-sentence outcome |
| **Scope** | In-scope files / behaviors |
| **Out of scope** | Explicit non-goals (other stages, unrelated bugs) |
| **Issue SoT** | Linked GitHub issue number(s) |
| **Acceptance** | Tests, build, lint, and any manual checks |
| **Constraints** | e.g. no `dist/` edits, no permission broadening, no version bump |
| **Stop rule** | After two identical failed fix attempts, stop and report |

## Completion report (required fields)

Workers should report:

1. **PR number / link**
2. **Files / configuration added or changed**
3. **Test / build / lint results** (commands + pass/fail)
4. **Manual GitHub / Cursor settings** the maintainer must flip (if any)
5. **Discoveries** that change later stage plans

Longer audit notes belong under the Project store `internal/` path, not as noisy chat dumps.

## Practices

- Prefer draft PRs until validation is green unless the repo convention says otherwise.
- Keep product bug fixes (`#4`–`#8`) out of foundation/infra PRs and vice versa.
- Re-read `AGENTS.md` before coding; follow exact install/test/build commands.
- Unit tests mock Kokoro; do not require Docker or a live API for ordinary CI.
