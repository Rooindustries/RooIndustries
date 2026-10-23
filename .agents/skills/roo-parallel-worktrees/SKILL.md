---
name: roo-parallel-worktrees
description: Isolate concurrent RooIndustries work in separate worktrees and branches with explicit file ownership.
---

# Roo parallel worktrees

Use this when parallel RooIndustries work is authorized. This skill does not
authorize launching more agents or threads. Read the session's worker rules
before delegating; a delegated worker stays within its assigned checkout.

1. Identify the current repository and its worktrees with
   `git rev-parse --show-toplevel`, `git remote`, `git worktree list --porcelain`
   and `git branch -a`. Confirm the intended origin privately; redact credentials
   before reporting any remote URL.
   Reuse the assigned branch/worktree when it exists. Keep other workers'
   branches, working files and servers untouched.
2. Give each task a branch, worktree, allowed files, shared-file restrictions and
   a check that proves its outcome. Use the requested base or bundle branch;
   otherwise use the current remote default branch. Do not switch the shared
   checkout's branch to prepare another task.
3. In T3, bind a requested new thread through `t3_thread_launch` with an explicit
   `workspaceStrategy`. For an authorized delegated task that needs isolation,
   use `delegate_task` with `isolation: "worktree"`. These start from committed
   state; commit the intended base first. A shell `cd` does not bind a T3 thread.
4. Outside T3, create the isolated checkout only after checking both the branch
   and destination. Use `git worktree add <path> <existing-branch>` for an
   unoccupied existing branch, or `git worktree add -b <new-branch> <path> <base>`.
   A branch already checked out elsewhere must be used in that worktree.

Coordinate ownership of `package.json`, `package-lock.json`, `next.config.mjs`,
`middleware.js`, `vercel.json`, `src/next/`, `src/components/Navbar.jsx`,
`AGENTS.md`, `CLAUDE.md` and these skills before editing them. If assigned scope
needs someone else's file, report the dependency to the owner instead of
absorbing their work.

Use separate test ports, build directories and artifacts for each checkout.
Follow `playwright.config.js` and `scripts/test-tooling-sweep-server.mjs` for
fixture isolation. Do not copy credentials into worktrees or aim tests at the
public site. The assigned integrator owns combining branches, review and
shipping; workers follow their handoff rules.
