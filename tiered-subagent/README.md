# Tiered subagent extension for Pi

An initial implementation of one `delegate` tool that routes bounded work to an isolated, ephemeral Pi subprocess.

## Implemented

- lower/default/higher provider-independent tiers
- LLM routing for automatic selection; explicit tier preference takes precedence
- worker and advisor modes
- explorer agent type for lower-tier, read-only repository search
- isolated context (task, expected outcome, explicit context, constraints, repository context files/skills)
- model/reasoning selection with current-model fallback
- hard prohibition of `gpt-5.6-sol` with `max` reasoning
- nested delegation disabled by child extension isolation and a depth limit
- structured completion and explicit uncertainty/escalation states
- timeout and cancellation propagation
- token, cost, model, reasoning, latency, and route-reason reporting
- conservative path reservations and parent/worker conflict blocking
- child path restrictions, including canonicalized symlink checks
- integration with the existing global safety-gate extension
- lifecycle event bus notifications and a compact active-agent widget

## Install for development

The safety gate blocks Pi itself from writing into the global extension directory. Install or link this manually:

```bash
ln -s /Users/qduc/src/pi-tiered-subagent ~/.pi/agent/extensions/tiered-subagent
```

Then run `/reload`.

## Configuration

Copy `tiered-subagent.example.json` to either:

- `~/.pi/agent/tiered-subagent.json`
- `<project>/.pi/tiered-subagent.json` (trusted projects only)

Project settings override global settings. Invalid or unknown fields fail closed.

If a configured model is unavailable, the extension can explicitly substitute the parent model. The substitution is included in `routeReason`. Sol `max` is never accepted, including as a fallback.

## Agent interface

The parent calls `delegate` with:

- `task`
- `expectedOutcome`
- optional concise `context`
- optional `constraints`
- optional `agentType` (`explorer`)
- optional `preferredTier`
- optional `mode`
- optional `fileScope`

Use narrow, non-overlapping `fileScope` values for concurrent workers. With the default `.` scope, only one worker can reserve the workspace at a time.

`agentType: "explorer"` is a deterministic specialization for repository search and inspection. It always selects the configured `lower` model and worker mode, regardless of `preferredTier` or `mode`, and exposes only `read`, `grep`, `find`, `ls`, and structured result submission. Use a normal worker for commands or file changes.

## Safety model

Child processes disable extension discovery and explicitly load only:

1. `child-runtime.ts`, which enforces delegated path scope and exposes the structured result tool.
2. `~/.pi/agent/extensions/safety-gate/index.ts`, when present.

The safety gate owns host/workspace safety. This extension additionally owns task scope, read restrictions, path reservations, parent conflicts, nesting, model policy, and limits.

For narrowly scoped workers, mutating shell commands are blocked because arbitrary shell mutation targets cannot be reliably attributed to a reservation. Use `edit`/`write`, broaden the declared scope deliberately, or escalate. Advisor mode receives only the structured result tool.

## Verify

```bash
npm test
npm run check
node --test ~/.pi/agent/extensions/safety-gate/policy.test.ts
```

## Current boundaries

- Parallelism comes from multiple independent `delegate` tool calls; there is no DAG scheduler.
- Cost limits are not yet implemented. Provider-reported actual cost is collected after responses.
- Exact shell filesystem confinement requires a container or OS sandbox; this version combines conservative shell restrictions with the existing safety gate.
- Routing-history analysis and recommendations are not yet persisted.
