# Tool Output Truncation

This Pi extension mechanically bounds oversized textual tool results. It keeps a head and tail excerpt in context, writes the observed text to an artifact, and provides `inspect_tool_output` for bounded reads and literal or regular-expression searches.

## Install

Link this directory into Pi's extension directory, then reload Pi:

```bash
ln -s /path/to/pi-extensions/tool-output-truncation ~/.pi/agent/extensions/tool-output-truncation
```

Run `/reload` in an active session. The package entry is `index.ts`.

## Configuration

Defaults are:

```json
{
  "maxChars": 40000,
  "headChars": 19000,
  "tailChars": 19000,
  "artifactDirectory": "~/.pi/agent/artifacts/tool-output",
  "maxInspectionChars": 20000
}
```

Put global settings in `~/.pi/agent/tool-output-truncation.json`. A trusted project may override individual settings in `.pi/tool-output-truncation.json`. Only the five documented keys are accepted. Limits must be positive safe integers, `maxChars` and `maxInspectionChars` must be at least 512 so notices remain explicit, and head plus tail cannot exceed `maxChars`. A leading `~/` in `artifactDirectory` expands to the user's home directory.

By default, artifacts are stored under Pi's user directory rather than the current project, so they do not appear as untracked Git files. Artifacts have collision-resistant generated names and contain the exact text observed by this extension. `inspect_tool_output` accepts the artifact filename shown in the truncation notice (and project-relative paths from older versions), plus an operation: `head`, `tail`, `characters`, `lines`, `literal`, or `regex`. Reads and searches are always limited by `maxInspectionChars`; artifact paths cannot be absolute, traverse directories, or use symlinks.

## API limitation

Pi built-in tools can truncate output before the `tool_result` hook runs. When Pi marks a result as already truncated, this extension says so and does **not** claim its artifact is complete or exact relative to the original command output. The extension preserves Pi's separate `details` and `isError` metadata.

The public core API is `truncateToolOutput(output, config, options)`. It treats text as opaque and does not summarize or interpret it.
