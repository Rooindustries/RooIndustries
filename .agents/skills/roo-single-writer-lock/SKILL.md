---
name: roo-single-writer-lock
description: Serialize cooperating writers for an explicitly shared RooIndustries checkout.
---

# Roo single-writer lock

Use an isolated worktree for parallel tasks. When the user explicitly assigns a
shared checkout, all writers must use the same advisory lock for the full
mutation, including edits, branch moves, stashes and commits. A lock cannot stop
tools or people that ignore it.

On the development laptop, run a bounded command under `flock`:

```bash
repo=$(git rev-parse --show-toplevel)
lock_file=$(git rev-parse --path-format=absolute --git-path roo-writer.lock)
flock --nonblock --conflict-exit-code 75 "$lock_file" \
  bash -euc 'cd "$1"; shift; "$@"' bash "$repo" <command> <arguments>
```

Replace `<command> <arguments>` with the actual operation. For several dependent
steps, put the entire sequence in that child shell or a task-owned script so
they hold one lock. Separate successful lock commands do not reserve the time
between them. The Git directory gives path aliases of one checkout the same
lock while keeping isolated worktrees independent.

Exit 75 means another writer holds it: leave the checkout untouched and report
the conflict. The operating system releases the lock when its owning process
and children close it. Never delete a live lock file to force a takeover; that
creates a different lock and permits two writers. A handoff requires the old
writer to finish first.

This replaces the old global claim/release helpers, whose shared session file
could let two sessions claim the same owner. No global session token or
credentials are needed. Check the repo state inside the lock before writing;
state inspected earlier may have changed.
