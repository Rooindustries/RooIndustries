---
name: roo-integrations-ops
description: Inspect or configure RooIndustries agent integrations, MCP connections and command hooks in the authorized profile.
---

# Roo integrations ops

Identify the harness, binary version and active profile before changing agent
configuration. Use `codex --version`, `codex mcp --help` or `claude --version`
and `claude mcp --help` as appropriate. This repo skill is not permission to
alter other profiles, restart shared services or change credentials.

For discovery, list connected MCP tools in the current harness. On the CLI,
`codex mcp list` or `claude mcp list` lists configured servers. Treat URLs,
headers and command environment values as private; report server names and
health without copying secrets into logs or issues.

Before adding or changing an integration:

1. Confirm the requested service, target profile and configuration scope. Reuse
   existing connections when they support the task.
2. Read the installed harness's current documentation for MCP, hooks and config.
   Do not assume Claude hooks and Codex hooks share events or schemas. Inspect
   the actual configured callback before testing it; a notify callback can send
   a message or change an external system.
3. Back up the exact config being changed outside the repository. Preserve
   unrelated entries. Keep per-session servers behind the existing `mcp-lazy`
   launcher where the machine's instructions require it.
4. Validate parsing and list the connection again. Exercise a read-only tool
   against a local fixture or the authorized service, and verify rollback.

Keep API tokens in the existing credential mechanism. The historical
`~/.codex/custom/mcp/` and `~/.codex/custom/hooks/` helper scripts are not shipped
with this repository; do not invoke them as prerequisites. This website now
uses Dodo Payments and Supabase; a legacy Sanity integration is not evidence of
the current booking or payment backend. Production mutations require the
task's authorization.
