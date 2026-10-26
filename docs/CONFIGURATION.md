# Configuration

## Locations

- Global: `~/.mookacode/config.json` (override root with `MOOKACODE_HOME`)
- Project: `<project>/.mookacode/config.json`
- Trusted projects: `~/.mookacode/trusted-projects.json`
- Sessions: `~/.mookacode/sessions`
- Secrets: `~/.mookacode/secrets.json` (encrypted; plaintext never stored)
- History: `~/.mookacode/history`
- Project memory: `<project>/.mookacode/memory.json` and generated `MEMORY.md`

A full example is in [examples/mookacode.example.json](../examples/mookacode.example.json).

## Project trust

Project-local providers, permissions, MCP servers, LSP servers and agents are ignored until trusted:

```powershell
mookacode config trust
mookacode config untrust
```

Trust is explicit because a cloned repository must not be able to silently execute commands.

## API keys

Resolution order:

1. Provider `apiKeyEnv` environment variable.
2. OS credential store (`mookacode auth set <provider>`).
3. No key (allowed for Ollama and OpenAI-compatible endpoints that don't require auth).

```powershell
mookacode auth status
mookacode auth set openai
mookacode auth remove openai
```

Windows uses DPAPI. macOS uses Keychain when available. Linux uses Secret Service when available; otherwise an AES-256-GCM file with `0600` permissions is used. Secrets are not included in sessions, logs or exported configuration.

## Provider examples

```json
{
  "providers": [
    {
      "id": "local",
      "name": "Local vLLM",
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [
        {
          "id": "my-model",
          "contextWindow": 32768,
          "maxOutputTokens": 4096,
          "supportsTools": true,
          "supportsStreaming": true
        }
      ]
    }
  ],
  "defaultProvider": "local",
  "defaultModel": "my-model"
}
```

For Anthropic use `type: "anthropic"` and base URL `https://api.anthropic.com`. For OpenAI use `type: "openai"` and `https://api.openai.com/v1`. Custom endpoints use `type: "openai-compatible"` (CLI alias `--type custom`). Add non-secret routing headers via `"headers": { "X-Org": "team" }`; all header values are redacted on `config show`/export. CLI:

```powershell
mookacode providers add --id local --type custom --base-url http://127.0.0.1:8080/v1 --model a,b --headers "X-Org: team" --api-key-env LOCAL_KEY --default
mookacode providers edit --id local --model c --base-url http://127.0.0.1:9090/v1
mookacode providers probe local
mookacode setup
```

## Permissions

```json
{
  "permissions": {
    "read": "allow",
    "edit": "ask",
    "command": "ask",
    "network": "allow",
    "gitWrite": "ask",
    "mcp": "ask",
    "commandRules": [
      { "pattern": "git status*", "decision": "allow" },
      { "pattern": "git reset --hard*", "decision": "deny" }
    ],
    "toolOverrides": {}
  }
}
```

Command rules only auto-apply to simple commands without shell operators. High-risk actions ask by default. Plan/ask/review modes cannot write or run mutating commands.

## MCP

```json
{
  "mcpServers": [
    {
      "id": "docs",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    }
  ]
}
```

Transports: `stdio`, `http` (Streamable HTTP), `sse`. Tools are exposed as `mcp__<server>__<tool>` with the server's input schema; total tools are capped to protect context. MCP servers from project config require trust.

## Custom agents

Project agents live in `.mookacode/agents/*.md`, global in `~/.mookacode/agents/*.md`.

```markdown
---
name: security-reviewer
description: Review security-sensitive changes
mode: review
tools: [read_file, search_text, git_diff, diagnostics]
maxIterations: 8
---

Your instructions...
```

Subagents cannot edit files. They may run commands only if their tool list and current permissions allow it.

## Memory and context

`memory.json` stores decisions, known issues, unfinished work and session summaries with deduplication and a cap. `.mookacode/memory.json` is loaded selectively by relevance. Session summaries are redacted and replaced per session rather than growing forever.

## Reasoning effort

`agent.effort` (`auto`, `low`, `medium`, `high`) controls how much reasoning budget the agent asks for. CLI: `--effort high`, interactive `/effort` (persists to config). Mappings:

- `openai` reasoning models (`o*`, `gpt-5*`) receive native `reasoning_effort`;
- models with `extra.supportsReasoningEffort: true` also receive it on any OpenAI-compatible endpoint;
- models with `extra.supportsThinking: true` receive an Anthropic extended-thinking budget;
- otherwise effort adjusts output-token budget, system guidance and temperature behavior only.

`auto` leaves provider defaults untouched.

Context budget is controlled by `context.maxInputTokens`, model context window, `compactAtPercent` and preference (`quality` / `balanced` / `economy`). Compaction preserves the current task and recent tool results.
