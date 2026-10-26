# Security

## Threat model

MookaCode is a local developer tool that can read files, edit code, run commands and call model APIs. It assumes the user trusts the model provider they configured and the MCP/LSP commands they install. It does **not** assume that cloned project content is trustworthy.

## Controls

### Credentials

- Environment variables take precedence over stored keys.
- Windows DPAPI (`CurrentUser`) protects stored secrets.
- macOS Keychain / Linux Secret Service are used when available; fallback is AES-256-GCM with a local key file and `0600` permissions.
- Secrets are redacted from tool output, sessions, memory, export and diagnostic messages.
- API keys are never passed to child shell commands: the command environment strips key/token/secret/password variables.

### Workspace isolation

- Every tool path is resolved against the real workspace root.
- `..`, absolute paths outside the root, symlinks and junctions escaping the root are rejected.
- Writes resolve the parent directory through `realpath`.
- Read/write sizes are bounded; binary files are rejected by text tools.
- Search skips binary files, heavy directories, `.gitignore` (including nested files) and `.mookacodeignore`.

### Permissions

- Categories: read, edit, command, network, gitWrite, MCP.
- Decisions: allow, ask, deny.
- Modes restrict tools before the model sees them: plan/ask/review are read-only; build/debug may edit.
- Compound shell commands do not get automatic allow from simple-command rules.
- Destructive Git operations are denied by default.
- CLI shows command, paths, diff/content preview and risk before approval.
- Project permissions/MCP/LSP/agents require explicit trust.

### Network

- `fetch_documentation` accepts only HTTP(S), blocks embedded credentials, follows at most five redirects, validates each destination and blocks loopback/private/link-local addresses by default.
- `MOOKACODE_ALLOW_LOCAL_NETWORK=1` is required for local docs endpoints.
- Web content is treated as untrusted data and marked as such in prompts/tool output.

## Explicit limitations

- **No OS sandbox.** Shell commands run as the current user. The permission system is a policy gate, not a container or VM. Do not run MookaCode against untrusted repositories with permissive command/edit settings.
- DNS rebinding cannot be fully prevented by URL validation; do not enable local network access for untrusted automation.
- An MCP or LSP server configured by the user is executable code. Trust only known configurations.
- Prompt injection is mitigated by instruction hierarchy and warnings, not eliminated. Review high-risk actions and keep `edit`/`command` on `ask` when working with untrusted content.
- Secrets may appear in model requests if the user explicitly allows reading them; redaction reduces accidental persistence, not intentional exfiltration.

## Recommended defaults

- Keep `edit: ask` and `command: ask`.
- Keep project trust off until the repository is reviewed.
- Store keys via `mookacode auth set`, not in config files.
- Use a dedicated API key with spending limits.
- Review Git diff after autonomous changes and use checkpoints to restore.
- Run `mookacode doctor` when behavior is unexpected.
