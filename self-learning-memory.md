# Goal: Adaptive Self-Learning Memory Extension

Design and implement a portable self-learning memory extension for an AI agent harness.

The extension should capture useful knowledge from completed work, consolidate it cautiously, and retrieve only relevant memory for future tasks.

The design should combine:

* a two-pass learning pipeline: session-level extraction followed by durable consolidation
* a clear separation between factual memory and reusable procedural knowledge
* adaptive model routing based on cost, cache availability, and task complexity
* inspectable, auditable, and portable persisted state

The extension should avoid depending on harness-specific behavior except through a small integration interface.

## Core behavior

After a meaningful completed task or session, the extension should preserve the session as evidence and run a first-pass extractor that produces immutable memory candidates.

The extractor must not directly modify durable memory or procedural skills.

A later consolidator reviews new candidates against existing knowledge and decides whether to:

* create a memory
* merge or update an existing memory
* supersede outdated knowledge
* reject weak or temporary information
* defer a decision until more evidence exists
* promote procedural knowledge into a draft skill or runbook

Before a future task begins, the extension should retrieve a small set of relevant memories and procedural summaries based on the current request and available execution context.

## Portable integration boundary

The extension should require only a small set of lifecycle and context inputs from the host harness:

* task or session started
* task or session completed
* current user request
* conversation transcript or normalized event history
* model configuration used by the foreground agent
* project, repository, workspace, or environment identity when available
* tool calls and results when available
* cancellation and shutdown signals

The extension should expose a similarly small interface:

* retrieve relevant memory
* inspect a memory
* search historical sessions
* propose a memory explicitly
* request that a memory be forgotten
* run pending extraction
* run pending consolidation

Harness-specific adapters should translate native events into this common interface.

## Pass 1: Candidate extraction

The first pass should identify potentially reusable knowledge from a completed unit of work.

Candidate types should include at least:

* user preferences
* stable facts
* project or environment constraints
* decisions and rationale
* corrections
* lessons from failed approaches
* successful procedures
* unresolved contradictions
* temporary observations that may later become durable

The extractor should optimize for recall while remaining conservative about certainty.

Its output should be structured, immutable, and evidence-backed.

Each candidate should include:

* candidate type
* proposed scope
* concise statement
* rationale
* confidence
* source session
* supporting message or event references
* suggested consolidation action
* uncertainty or contradiction markers

“No durable learning found” must be a valid result.

## Adaptive extractor routing

The extractor should choose between two execution paths.

### Warm-cache path

Reuse the exact foreground model configuration when:

* the completed task was complex, ambiguous, or high-value
* preserving the foreground model’s interpretation is important
* extraction runs soon enough for prompt-cache reuse
* the same stable prompt prefix can be preserved
* the model, reasoning level, tools, and other cache-relevant settings remain unchanged

Changing the reasoning level must be treated as breaking prompt-cache reuse.

This path should use a tightly bounded output format and should not continue foreground task execution.

### Economy path

Use a cheaper model when:

* the task was routine or mechanically understandable
* the foreground cache is unavailable or cold
* extraction is delayed or processed in a batch
* replaying the full session is uneconomical
* a compact digest can preserve the important evidence

The cheaper extractor must escalate uncertainty rather than guess.

It should never be trusted to mutate durable state directly.

## Session digesting

When the economy path cannot economically consume the full session, the extension may construct a compact digest.

The digest should preserve:

* the user’s original goal
* important corrections
* decisions and rationale
* notable failed attempts
* successful final approach
* relevant tool results
* unresolved questions
* exact evidence references

Digest generation should be deterministic where possible.

An LLM-generated summary must not replace the original session as the source of truth.

## Pass 2: Consolidation

The consolidator is the higher-judgment stage.

It should compare new candidates with existing durable knowledge and determine the correct mutation.

Possible actions should include:

* create
* merge
* update
* supersede
* reject
* defer
* narrow scope
* promote to procedural knowledge
* flag for human review

The consolidator should handle:

* contradiction detection
* scope selection
* deduplication
* temporal validity
* preference changes
* competing decisions
* evidence strength
* procedural knowledge updates

Straightforward candidates may use a normal reasoning tier.

Conflicts, broad-scope changes, and procedural mutations should escalate to a stronger model tier.

Consolidation should run less frequently than extraction and may process candidates in batches.

## Knowledge model

The system should distinguish at least:

### Factual memory

Small durable statements about preferences, constraints, environments, projects, or recurring truths.

### Decisions

Choices that retain rationale, alternatives, date, scope, and supporting evidence.

### Procedural knowledge

Reusable workflows, troubleshooting procedures, runbooks, or skills.

Procedural knowledge should be lazy-loaded rather than always injected.

### Session history

Complete or normalized historical sessions that remain searchable as evidence.

Session history should not be automatically injected in full.

### Candidates

Immutable first-pass observations awaiting consolidation.

Candidates are evidence records, not durable truth.

## Scope model

Every candidate and durable memory should declare the narrowest valid scope.

Supported scopes may include:

* global
* user
* organization
* project
* repository
* workspace
* branch
* environment
* session

The extension should degrade gracefully when the host harness cannot provide every scope type.

## Retrieval

Memory retrieval should occur before the foreground agent begins substantial reasoning.

The retriever should use available signals such as:

* current user request
* active project or repository
* working directory
* task type
* recent conversation context
* memory type
* scope
* confidence
* recency
* prior usefulness

The output should be a small relevance-filtered context package.

It should prefer omission over marginal relevance.

The extension should support progressive disclosure:

* compact always-available core
* relevant memory summaries
* references to additional memory
* full procedural knowledge only when explicitly activated or strongly relevant
* session-history search only when needed

The system should not inject full memory files, raw candidates, or broad session summaries by default.

## Procedural learning

A successful procedure may be promoted into a draft skill or runbook.

Procedural knowledge should have lifecycle states such as:

* draft
* active
* trusted
* stale
* archived

Rules should include:

* existing procedural knowledge must be read before modification
* targeted patches are preferred over complete rewrites
* every mutation keeps provenance and revision history
* a failed use lowers confidence rather than immediately deleting the procedure
* promotion to trusted status requires repeated successful use or explicit approval
* conflicting procedures should not be silently merged

Automatic trusted skill mutation is outside the MVP.

## Evidence and auditability

Every durable item should retain:

* unique identifier
* type
* scope
* confidence
* creation time
* last confirmation time
* source sessions
* supporting evidence references
* revision history
* superseded entries
* usage or retrieval history when available

The extension should be able to answer:

* Why does this memory exist?
* Where did it come from?
* When was it last confirmed?
* What did it replace?
* Has it been useful?
* What evidence contradicts it?

Persisted state should be inspectable without specialized infrastructure.

The exact storage format may be Markdown, JSON, SQLite, or a combination, but the semantic model should not depend on one format.

## Safety and quality constraints

* Foreground task success must never depend on memory maintenance succeeding.
* Candidate extraction must not directly mutate durable memory.
* One unusual incident must not automatically become a permanent rule.
* Agent inference should require stronger or repeated evidence than explicit user statements.
* Explicit remember and forget requests should receive priority while remaining auditable.
* No procedural knowledge may be patched without loading its current contents.
* Memory writes must be atomic and reversible.
* Partial consolidation must not leave the store in an inconsistent state.
* Retrieval failure must allow the foreground task to continue without fabricated memory.
* The active prompt should not be rewritten midway through a running turn.
* Sensitive or secret values should be excluded or redacted according to host policy.
* Lower-cost models must escalate uncertainty rather than invent conclusions.

## Scheduling

The design should support multiple execution modes:

* immediate post-task extraction
* delayed extraction
* idle-time processing
* startup processing
* manual processing
* batched consolidation

Warm-cache extraction should run immediately enough to preserve cache eligibility.

Delayed or batched extraction should assume a cold cache and use the economy path unless proven otherwise.

The system should not require a continuously running background service.

## MVP boundary

The MVP should include:

* persistent session evidence
* immutable candidate records
* factual and decision memory
* global and project-like scopes
* adaptive extractor routing
* delayed or batched consolidation
* keyword and metadata retrieval
* provenance and evidence
* atomic local persistence
* non-blocking failure handling
* a portable host adapter interface

The MVP should not require:

* embeddings
* vector databases
* knowledge graphs
* autonomous deletion
* automatic trusted skill mutation
* cross-device synchronization
* continuous background workers
* complex learned ranking
* automatic conflict resolution without evidence

## Future extensions

The design should leave room for:

* semantic retrieval
* procedural skill generation
* targeted skill patching
* periodic curation
* stale and archived states
* approval queues
* cross-agent shared memory
* learned retrieval ranking
* usage-based confidence
* contradiction review
* memory import and export
* policy-controlled secret handling

## Success criteria

The extension is successful when an integrated agent:

* avoids repeatedly rediscovering known information
* preserves important corrections and decisions across sessions
* retains reusable procedures without always loading them
* does not flood the foreground context with historical noise
* does not promote weak inference into durable truth
* can explain the evidence behind each durable memory
* chooses rationally between warm-cache reuse and cheap-model extraction
* reserves stronger models for durable, high-impact judgment
* remains portable across agent harnesses
* remains understandable and debuggable through persisted local state

The central invariant is:

> Extraction may propose what was learned, but only consolidation may decide what becomes durable.
