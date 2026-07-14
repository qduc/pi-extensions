# Tool-Output Truncation Extension Specification

## Goal

Build a Pi extension that prevents oversized textual tool results from consuming excessive model context.

The extension treats tool output as opaque text. It does not attempt to identify test failures, compiler errors, log levels, JSON structure, or other output-specific meaning.

When output exceeds a configured limit, the extension must:

1. Preserve a bounded excerpt in the conversation.
2. Store the complete output as an artifact.
3. Clearly disclose what was omitted.
4. Let the agent inspect the artifact through bounded reads and searches.

## Design Principles

### Do not interpret output

Tool output has no universal format. The extension must not guess which lines are important or claim to identify causal errors.

Truncation must be mechanical and deterministic. Given the same input and configuration, it must return the same result.

### Never truncate silently

A truncated result must state:

* that truncation occurred
* the original size
* the returned size
* which ranges were retained
* how much content was omitted
* where the complete output is stored

### Keep complete output recoverable

The artifact must contain the exact original textual result. Artifact inspection must itself be bounded so that it cannot reinsert the entire oversized result into context.

### Preserve tool metadata

Tool metadata supplied separately by Pi, such as success state, exit status, or error state, must remain unchanged. The extension must not infer metadata from output text.

## Scope

The MVP governs completed textual tool results.

It does not require:

* tool-specific output parsers or reducers
* output classification
* semantic summarization
* LLM summarization
* active-model tokenization
* sensitive-content detection or redaction
* context-pressure-aware limits
* streaming reduction
* artifact retention or indexing
* session metrics
* special handling for subagents
* binary, image, or interactive terminal output

These features may be considered later only when concrete usage demonstrates a need.

## Configuration

The extension should support a small configuration surface:

```json
{
  "maxChars": 40000,
  "headChars": 19000,
  "tailChars": 19000,
  "artifactDirectory": ".pi/artifacts/tool-output",
  "maxInspectionChars": 20000
}
```

Constraints:

* All limits must be positive safe integers.
* `maxChars` and `maxInspectionChars` must be at least 512 characters so truncation can always be disclosed.
* `headChars + tailChars` must not exceed `maxChars`.
* `maxChars` includes the truncation notice and retained excerpts.
* Invalid configuration must produce a clear startup error.
* Character limits are sufficient for the MVP. Token estimates are not required.

## Truncation Behavior

### Results within the limit

If the textual output length is less than or equal to `maxChars`, return it unchanged and do not create an artifact.

### Results over the limit

If output exceeds `maxChars`:

1. Save the exact complete output to an artifact.
2. Retain up to the first `headChars` characters.
3. Retain up to the last `tailChars` characters.
4. Insert an explicit truncation notice between the retained ranges.
5. Return no more than `maxChars`, including the notice.

If the notice and configured excerpts would exceed `maxChars`, shorten the head and tail excerpts by approximately equal amounts until the complete returned text fits.

The implementation should avoid splitting a Unicode surrogate pair. It may align excerpt boundaries to nearby newline boundaries when that does not materially exceed the configured limits.

Example:

```text
<first retained range>

[Tool output truncated]
Original: 128,430 characters
Returned excerpts: characters 1-19,000 and 109,431-128,430
Omitted: 90,430 characters
Full output: .pi/artifacts/tool-output/bash-a91f.log

<last retained range>
```

The notice must not characterize the retained ranges as the most important content. They are only the beginning and end of the original output.

### Empty and non-text results

Empty textual output must remain empty. Non-text content must pass through unchanged and is outside the MVP.

## Artifact Storage

Artifacts must be written beneath the configured artifact directory using collision-resistant filenames. Filenames must not include raw command arguments or output content.

An artifact must contain the exact original text with no additional headers, redaction, or transformation.

The extension should create the artifact directory when needed. Artifact cleanup and cross-session discovery are outside the MVP.

If an artifact cannot be written, the extension must:

* still return a bounded head-and-tail result
* state that the complete output was not saved
* include a concise artifact-write error
* preserve the original tool success or failure metadata

## Artifact Inspection Tool

Register one tool for selective artifact inspection. It should support:

* reading a character or line range
* searching for a literal string
* optionally searching with a regular expression
* reading the beginning or end

Every operation must enforce `maxInspectionChars`. If an inspection result exceeds that limit, apply the same explicit head-and-tail truncation behavior.

The tool must only access files beneath the configured artifact directory. It must reject absolute paths, path traversal, symlink escapes, and non-artifact files.

Search results should return bounded matching lines with line numbers and a count indicating when additional matches were omitted. Search does not rank or interpret matches.

## Failure Behavior

Truncation failures must not hide the tool result or change whether the original tool succeeded.

If excerpt construction fails, return the largest safe bounded prefix available and disclose the failure. The extension must not retry indefinitely or replace the original tool error with an extension error.

## Integration

The extension should use the narrowest Pi hook that can transform completed tool results before they enter model context. UI rendering is a separate concern and need not change.

If Pi already truncates a built-in tool result before the extension can observe it, the extension must not claim that its artifact contains the complete output. This API limitation must be documented and validated before implementation proceeds.

The same truncation function should be reusable wherever a caller can provide text and receive bounded text plus an optional artifact reference. No separate subagent architecture is required for the MVP.

## Suggested Interface

```ts
interface TruncationConfig {
  maxChars: number;
  headChars: number;
  tailChars: number;
  artifactDirectory: string;
  maxInspectionChars: number;
}

interface TruncationResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  returnedChars: number;
  artifactPath?: string;
  artifactError?: string;
}

function truncateToolOutput(
  output: string,
  config: TruncationConfig,
): Promise<TruncationResult>;
```

This interface may be adapted to Pi's extension API, but the behavioral contract should remain independent of tool type.

## Tests

Cover the following behavior:

* output below the limit is unchanged
* output exactly at the limit is unchanged
* oversized output retains the configured head and tail
* the notice reports correct sizes and ranges
* the artifact exactly matches the original output
* empty output remains unchanged
* Unicode boundaries are not corrupted
* extremely long individual lines remain bounded
* artifact filename collisions are avoided
* artifact-write failure returns bounded output with disclosure
* inspection range reads are bounded
* inspection searches report omitted matches
* traversal and symlink escapes are rejected
* inspection output cannot bypass the configured limit
* original tool success and failure metadata are preserved

## Acceptance Criteria

The MVP is complete when:

* textual results within the configured limit enter context unchanged
* oversized results never enter context in full
* truncation is deterministic and explicitly disclosed
* retained content consists only of mechanical head and tail excerpts
* the complete exact output is recoverable when artifact writing succeeds
* artifact reads and searches are selective and bounded
* artifact access cannot escape the configured directory
* artifact failures do not hide or alter the original tool outcome
* no behavior depends on recognizing a particular output format

## Future Work

Additions should be driven by observed failures of this MVP. Potential extensions include streaming writes, retention policies, byte limits, or caller-supplied exact ranges. Semantic reducers should not be introduced unless their reliability and benefit can be demonstrated for a narrowly defined format.

