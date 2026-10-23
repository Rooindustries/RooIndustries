---
name: roo-single-folder-guard
description: Audit the shared RooIndustries checkout, or normalize it only when the user explicitly requests a branch move.
---

# Roo single-folder guard

Use this only for work intentionally assigned to a shared checkout. Prefer the
assigned isolated worktree when parallel workers exist. Never normalize another
thread's checkout.

## Continue: read-only default

Run from the assigned repository root:

```bash
git status --short --branch
git worktree list --porcelain
git branch -a
git symbolic-ref --quiet --short refs/remotes/origin/HEAD
```

If current remote state is needed, `git fetch origin` updates remote references
without moving this checkout. Resolve the remote default branch from
`refs/remotes/origin/HEAD`, then use `git merge-base --is-ancestor <remote-default>
HEAD` to check freshness. Report detached HEAD, dirty files, missing remote
default or divergence rather than guessing `main` or moving branches.

## Fresh: explicit normalization

Only a request to normalize this checkout permits changing its branch. First
confirm no other worker owns it and use `roo-single-writer-lock` for the entire
mutation. Require a clean index and working tree, including untracked files.
Preserve dirty work and stop if it exists; do not automatically stash or reset.

Fetch origin, resolve its default branch, and inspect `git worktree list` before
switching. If the default branch is occupied elsewhere, use an isolated
worktree instead. Otherwise switch to the local default branch (create it to
track the remote default only if missing) and fast-forward with
`git merge --ff-only <remote-default>`. Divergence must remain intact.

Check the final branch, status and ancestry before handing back. This procedure
does not authorize deployment or edits to other worktrees.
