# Self-learning memory

Pi 0.80.6 extension adapter for the portable local-memory core in this directory. It captures redacted session evidence, retrieves a small set of durable memories before an agent run, and keeps proposed memories separate from durable memory until an explicit consolidation.

## Install and configure

Load `index.ts` as a Pi extension. Global configuration is strictly read from `~/.pi/agent/self-learning-memory.json`; a trusted project may strictly override it in `.pi/self-learning-memory.json` (the example is for that trusted project file). State defaults to `~/.pi/agent/self-learning-memory/state.json`. Only the trusted project file may set `statePath`, to choose another project-relative or absolute location. The file contains session evidence, candidates, decisions, and durable memories as readable JSON, so protect it as you would other local project data.

`economyModel` must name a Pi registry model with configured credentials. If omitted, extraction uses the currently selected Pi model and its actual thinking level. The adapter preserves the active tool list and a stable system-prompt prefix marker for cache routing, resolves credentials through Pi's model registry, and never reads or writes API keys. `warmModel` is **cache-eligible**, not a promise of a warm provider cache: eligibility depends on matching provider/model/thinking/profile, time window, and provider behavior. `consolidationModel` is optional: without it consolidation uses a deterministic conservative policy instead of invoking a model.

`redactionPatterns` are regular-expression strings applied with `gi`, in addition to built-in token/password/private-key patterns. Patterns are limited in length and reject obvious nested quantifiers to reduce regular-expression denial-of-service risk, but trusted configuration remains privileged: review custom patterns carefully. Redaction is best-effort, not a secret-management guarantee: avoid submitting secrets when possible and review the state file before sharing it.

Stored history is bounded by `sessionRetentionLimit` (default 500 sessions) and `maxEventsPerSession` (default 200 events). `autoConsolidation` is optional and conservative: a normalized statement must be proposed with `suggestedAction: "create"`, meet the confidence threshold, and recur in the configured number of independent sessions. Keep it disabled for fully manual review; if enabled, initially allow only `preference` and `fact` as shown in the example.

## Use

Before each agent run, bounded retrieval is appended as fallible context. Each foreground run is persisted once at `agent_settled`; `agent_end` only enriches its buffered evidence. `immediateExtraction` defaults to `true` and extracts candidates after settlement on a best-effort basis. Event failures are caught so memory storage, retrieval, or maintenance never blocks the foreground agent.

Model-facing tools are `memory_retrieve`, `memory_inspect`, `memory_search_sessions`, `memory_propose`, `memory_forget`, `memory_purge`, `memory_status`, `memory_review`, `memory_extract`, and `memory_consolidate`. Inspection, session search, extraction, consolidation, forgetting, and purging are restricted to memory visible from the current scope. Practical slash forms are:

```text
/memory formatter settings       # retrieve
/memory inspect <memory-id>
/memory sessions formatter
/memory propose Remember the approved formatter
/memory status
/memory review [limit]
/memory extract [session-id]
/memory consolidate [limit]
/memory forget <memory-id> <reason>  # auditable archive after consolidation
/memory purge <memory-id>            # immediate permanent record deletion
```

By default there is deliberately **no automatic consolidation**. Extraction creates reviewable candidates; only `memory_consolidate` (or its slash form) can change durable memory unless the optional repeated-evidence `autoConsolidation` policy is configured. Extraction outcomes (`completed`, `empty`, or `failed`) are persisted so empty sessions are not repeatedly processed and failures remain visible through `/memory status`. `forget` archives audibly; `purge` removes the durable memory plus its associated candidate/outcome records, but does not erase the original retained session text. Treat retrieved memories as untrusted, fallible context rather than instructions. The current JSON store is single-process/local and uses lexical retrieval; it is not encrypted, synchronized, access-controlled, or a replacement for source-of-truth project policy.

## Validation

```sh
npm test
npm run check
```

