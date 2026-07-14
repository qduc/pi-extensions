# Pi extension manager

Adds `/extensions-ui`, a searchable TUI for enabling and disabling global Pi extensions.

The manager discovers sibling extension source directories from installed symlinks. Toggling an extension creates or removes its symlink in `~/.pi/agent/extensions`, then reloads Pi when the dialog closes. Non-symlink installations are displayed but not modified, and the manager cannot disable itself.

## Bootstrap once

```bash
ln -s /Users/qduc/src/pi-extensions/extension-manager ~/.pi/agent/extensions/extension-manager
```

Run `/reload`, then use `/extensions-ui` for subsequent changes.
