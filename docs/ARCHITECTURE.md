# Architecture

## Process model

```text
mookacode (single Node process)
├── CLI        TUI / readline / prompts / ANSI renderer
├── Core       config, auth, providers, agent, tools, permissions,
│              sessions, context, Git, LSP, MCP, subagents
└── Protocol   shared types and events
```

- CLI запускает Core **в том же процессе** — без демона, локального HTTP-сервера и второго экземпляра логики.
- Всё общение идёт через `MookaCore` и типы из `@mookacode/protocol`; Core ничего не знает про рендеринг и ввод.
- Сборка — один CJS-бандл `packages/cli/dist/mookacode.cjs` (esbuild), единственная внешняя зависимость в рантайме — Node.js 20.11+.
- Версия попадает в бандл на этапе сборки (`__MOOKACODE_VERSION__` ← `packages/cli/package.json`), поэтому `--version`, LSP `clientInfo` и MCP `clientInfo` не расходятся.

## Core modules

| Module        | Responsibility                                                    |
| ------------- | ----------------------------------------------------------------- |
| `config`      | defaults, schema validation, global/project merge, trust          |
| `auth`        | OS credential store, env resolution, no secret logging            |
| `providers`   | Anthropic/OpenAI-compatible adapters, SSE, tools, retry, usage    |
| `agent`       | loop, tool execution, limits, cancellation, verification reminder |
| `tools`       | file/search/command/Git/LSP/web/memory tools, executors           |
| `permissions` | allow/ask/deny, command rules, mode constraints, confirmations    |
| `sessions`    | atomic records, index, resume, archive, redaction                 |
| `context`     | instructions/AGENTS.md, memory, token estimation, compaction      |
| `subagents`   | read-only specialists, custom agents, concurrency limit           |
| `mcp`         | stdio/HTTP/SSE MCP client, tool allowlist/cap                     |
| `lsp`         | framed JSON-RPC, diagnostics, idle disposal                       |
| `git`         | status/diff/log/show/branch/checkpoint; no destructive resets     |
| `workspace`   | path guard, symlink checks, nested `.gitignore` walker            |

## Agent loop

1. Resolve provider/model and session.
2. Load AGENTS.md/instructions, project profile, relevant memory, Git status.
3. Optionally create a non-destructive Git checkpoint.
4. Build a compact system prompt and mode-specific tool set.
5. Compact context if over budget.
6. Stream provider response and accumulate tool calls.
7. Check permissions; execute tools sequentially; persist each result.
8. Block duplicate calls, enforce iteration/tool/time budgets.
9. If files changed, remind the model to verify.
10. Persist summary, update memory and emit completion.

Tool calls are sequential to avoid concurrent edits. Subagents are limited to two at a time and run with a restricted tool set. The main agent is instructed to verify subagent findings.

## Storage layout

```text
~/.mookacode/                     (override with MOOKACODE_HOME)
├── config.json                   global configuration
├── secrets.json                  encrypted credentials (DPAPI / Keychain / Secret Service / AES-GCM)
├── trusted-projects.json         projects allowed to apply local config
├── sessions/                     session records
└── history                       interactive input history

<project>/.mookacode/
├── config.json                   project configuration (requires trust)
├── memory.json                   project memory
└── agents/*.md                   custom subagents
```

## Safety model

- Workspace root is realpath-normalized; writes resolve the existing parent and reject symlink escapes.
- File edits support exact replacement, SHA-256 conflict detection and unified diff output.
- Shell commands use a timeout, process-tree kill, sanitized environment and output truncation.
- Network fetch validates redirects and blocks loopback/private addresses unless `MOOKACODE_ALLOW_LOCAL_NETWORK=1`.
- No OS sandbox is claimed. Permissions are a policy gate, not isolation.

See [SECURITY.md](SECURITY.md).
