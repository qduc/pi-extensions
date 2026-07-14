# Pi safety gate

A global, fail-closed pre-execution gate for Pi's built-in `bash`, `write`, and `edit` tools.

## Outcomes

- **Safe** — ordinary reads, workspace edits, and routine development commands run immediately.
- **Risky** — Pi shows the action, affected path/state, rule, reason, and safer alternative, then requires explicit confirmation. In non-UI modes, risky actions are blocked.
- **Prohibited** — the action is blocked and cannot be approved from the prompt.

The gate resolves relative paths against the active workspace, expands known environment variables and `~`, canonicalizes existing path components to catch symlink escapes, and inspects each segment of shell chains. Unknown dynamic mutation paths fail closed.

By default, potentially destructive but inspectable actions—including workspace escapes, system paths, privilege escalation, service/system control, indirect deletion, force pushes, and history rewriting—require confirmation. Prohibited actions are reserved for opaque or uninspectable commands, unresolved dynamic mutation paths, direct `.git` mutation, workspace-root deletion, configured blocks, and attempts to modify the policy itself. Sensitive files and recursive in-workspace deletion also require confirmation.

## Project configuration

A trusted project may add `.pi/safety-gate.json`:

```json
{
  "protectedPaths": ["production", "data/irreplaceable"],
  "allowedExternalPaths": ["../shared-generated"],
  "confirmCommands": ["^docker\\s+compose\\s+down\\b"],
  "blockedCommands": ["^terraform\\s+(?:apply|destroy)\\b"],
  "git": {
    "forcePush": "confirm",
    "hardReset": "confirm",
    "deleteBranch": "confirm",
    "rewriteHistory": "confirm",
    "clean": "confirm",
    "discardChanges": "confirm"
  }
}
```

Paths are literal path prefixes, relative to the workspace unless absolute. `~` and defined environment variables are expanded. `confirmCommands` and `blockedCommands` contain case-insensitive JavaScript regular expressions. Block rules and built-in prohibitions take precedence over confirmation rules and external-path allowances. Invalid configuration fails closed.

Project configuration is read only for trusted projects and is re-read for each intercepted action, so no reload is needed. Pi itself cannot modify `.pi/safety-gate.json`; edit it manually outside the agent run.

## Remembered approvals

Risky actions offer four choices: deny, allow once, allow the exact action for the current session, or allow the exact action for the current project. Project approvals are available only for trusted projects and are stored in `~/.pi/agent/safety-gate-approvals.json`; they can also authorize an exact match in non-UI modes. Policy evaluation always runs first, so remembered approvals never override a prohibited decision.

Use `/safety-approvals` to list, revoke, or clear approvals for the active project. Session approvals are discarded when the extension runtime ends.

## Customize and test

The policy is intentionally explicit and contained in `policy.ts`. Run:

```bash
node --test ~/.pi/agent/extensions/safety-gate/*.test.ts
```

After changing extension code, run `/reload` in Pi.

## Scope

This gate covers Pi's built-in shell and file mutation tools. A third-party extension that performs mutations through a differently named custom tool must implement equivalent checks or be added explicitly to `index.ts`.
