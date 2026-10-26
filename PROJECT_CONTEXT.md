# PROJECT_CONTEXT

## Состояние

MookaCode `0.1.0` — CLI-версия, единственный продукт проекта. Дата обновления: 2026-10-26.

Desktop-приложение вынесено из репозитория (`apps/desktop` удалён, архив лежит вне проекта) и в публичный релиз не входит. Всё, что относилось к Tauri/React/worker, из кодовой базы и CI убрано.

Проверено на Windows 11 (Node 22.22):

- `pnpm typecheck`, `pnpm lint` (0 проблем), `pnpm test` (16 тестов), `pnpm build`, `pnpm smoke` — проходят.
- `pnpm build` → `packages/cli/dist/mookacode.cjs`, `--version` = `0.1.0` из `packages/cli/package.json`.
- Установка из исходников: `scripts/install-cli.ps1` (Windows), `scripts/install-cli.sh` (Linux/macOS).
- Установка из релиза: `install.ps1` / `install.sh` в корне — скачивают бандл и SHA-256 из GitHub Releases.

## Архитектура

```text
packages/protocol   общие типы, события
packages/core       config/auth, providers, agent, tools, permissions, sessions,
                    context/memory, Git, LSP, MCP, subagents
packages/cli        TUI, readline, permission prompts, команды, ANSI renderer
```

Core работает в процессе CLI. Сборка — один CJS-бандл через esbuild, без локального HTTP-бэкенда и фоновых процессов. Версия инжектится в бандл (`__MOOKACODE_VERSION__`), чтобы `--version`, LSP и MCP clientInfo не расходились.

## Принятые решения

- TypeScript Core вместо Rust: один код, провайдеры и инструменты проще тестировать.
- Публикуемый пакет — `mookacode` (`packages/cli`), workspace-корень называется `mookacode-workspace`.
- OS credential store: Windows DPAPI; macOS Keychain; Linux Secret Service; AES-GCM fallback. Ключи не попадают в конфиг/сессии/экспорт.
- Проектный trust: локальные permissions, MCP, LSP, агенты игнорируются до `config trust`.
- Git checkpoint через `git stash create` + скрытый ref; без `reset --hard`.
- Контекст: лимит провайдера/модели, эвристическая оценка, компакция старых ходов, дедупликация tool results, усечение.
- В CLI есть питомец-компаньон (truecolor #40C8FF / #0F1923, 15×6), команды `/pet` и `/effort`, флаг `--pet`.
- Провайдеры настраиваются полностью: `providers setup` (мастер), `providers add` (несколько моделей, headers, api-key env, `--default`), `providers edit`, `providers probe`.
- Effort (`auto|low|medium|high`): `--effort`, `/effort`, маппинг в `reasoning_effort` / Anthropic thinking budget / общий бюджет вывода.

## Проверенные сценарии

- streamed text/tool calls (OpenAI-compatible и Anthropic SSE);
- permission allow/deny и `alwaysAllow`;
- отмена run и `interrupted` session с pendingTask;
- auth error 401 → failed + resumable session;
- `edit_file`, hash conflict protection для overwrite;
- nested `.gitignore`, workspace traversal/symlink guard;
- context compaction;
- sessions persistence + secret redaction;
- Git status/diff/log/checkpoint restore;
- реальный stdio MCP server (listTools/callTool);
- CLI one-shot E2E через fake SSE → `write_file` → файл на диске.

## Известные ограничения

- OS-level sandbox отсутствует: команды выполняются с правами пользователя и контролируются permissions.
- LSP требует установленного language server (`typescript-language-server` по умолчанию не входит).
- Web search использует DuckDuckGo HTML без ключа или Brave при `BRAVE_SEARCH_API_KEY`.
- Цена в USD считается только при заданных тарифах и без неопределённости по cache-токенам.
- Linux/macOS проверены сборкой и smoke в CI, но не профилировались по производительности.
- Публикация в npm требует `NPM_TOKEN` и прав на имя `mookacode`; workflow готов, но выключен без секрета.

## Следующий шаг

1. Прогнать CLI на реальном API Anthropic/OpenAI и локальной Ollama.
2. Профилировать startup и RSS на Linux/macOS.
3. Добавить E2E-тест one-shot прогона в CI (fake SSE, без ключей).
4. Интерактивный выбор и установка language server для LSP.
5. Заменить placeholder `fraer-techet/mookacode` на реальный slug репозитория в `package.json`, `README.md`, `install.sh`, `install.ps1`.
