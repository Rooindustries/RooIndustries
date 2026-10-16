# Repository rules

These rules apply to every agent and every contributor working in this repository.

## Keep agent process artifacts out of Git

Only files a maintainer can run or read on purpose belong in the repository. Never commit:

- Review-round or process leftovers: "fixround", "outside-data", "evidence", "proof", "rehearsal", "signoff" or "before-source" scripts, fixtures, inventories or JSON reports.
- Captured database dumps, rollback captures or schema snapshots taken from a local or test database.
- Scripts that only work on one machine: hardcoded /tmp, /Users or /home paths, personal worktree paths, or binaries built for one box.
- Test or check scripts that no package.json script, config file or source file runs. If a check matters, wire it into package.json; if it does not, do not add it.
- Generated reports, screenshots, traces or test output. Those stay under the gitignored test-results/ and audit/ directories.
- Minified or single-line code. Scripts use the same formatting as src/.
- Narrating comments, docstrings, banners, generated-by markers or process notes. Comment only where the code cannot explain itself.

## Public Git text

- Commit subjects are conventional and under 72 characters; the body stays empty.
- No model or tool attribution, co-author trailers, signatures or generated-by footers in commits, pull requests or files.
- Pull request text describes completed functional changes only, with no testing or verification narration.

## Before opening a pull request

- `git status` shows only the files the change needs. Delete scratch files instead of renaming or parking them.
- Every new script runs from a clean checkout without machine-specific paths; fixture locations come from environment variables with documented defaults.
- Branch names use the `servi/` prefix with a short description, for example `servi/review-carousel-loop`.

## Cursor Cloud specific instructions

Cloud agents for this repository group also have LeanClientOptimizer and RooTourney checked out beside this repo. Install dependencies with `npm ci` in this repo and in RooTourney, and `python3 -m pip install --user -r tools/validation/requirements.txt` in LeanClientOptimizer.

Boot serves local fixtures. They do not use a production Supabase project.

- This site listens at http://127.0.0.1:3211. `npm test` is the unit suite. `BASE_URL=http://127.0.0.1:3211 npm run test:agent-readiness` checks the running site.
- RooTourney listens at http://0.0.0.0:3253. Open `/tourney/login` on that host. Sign in as `browser-owner` with password `CloudAgentOwner!234567890`. Owner controls are at `/tourney/manage`. `npm test` is the unit suite. End-to-end runs need `PG_BIN=/usr/lib/postgresql/17/bin`.
- LeanClientOptimizer on Linux: `python3 tools/validation/check_baseline.py`. The desktop app and PowerShell regressions need Windows.
