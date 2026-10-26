# Troubleshooting

## `mookacode` not found

Установщик обновляет **пользовательский** PATH. Откройте новый терминал либо запустите бандл напрямую:

```bash
# Windows
& "$env:LOCALAPPDATA\MookaCode\bin\mookacode.cmd" --version

# Linux / macOS
~/.local/bin/mookacode --version
node ~/.local/share/fraer-techet/mookacode.cjs --version
```

Если ставили через npm: проверьте `npm bin -g` / `npm prefix -g` и что каталог бинарников в PATH.

## Missing API key / 401

```bash
mookacode auth status
mookacode auth set anthropic
mookacode providers probe anthropic
```

Переменные окружения имеют приоритет над хранилищем. `mookacode models` показывает `missing` / `env` / `store`.

## Model does not support tools

MookaCode требует tool calling. Ставьте `supportsTools: true` только если endpoint действительно поддерживает tool calls; иначе выберите другую модель.

## Model returns 400/404

- Проверьте Base URL вместе с префиксом (`/v1` для OpenAI-compatible, корень для Anthropic).
- `mookacode providers probe <id>`.
- Проверьте `providerModelId` и лимиты контекста.
- OpenAI-compatible серверы различаются: некоторые игнорируют `stream`, некоторые отвергают `temperature`, некоторые не реализуют tool calls.

## LSP diagnostics unavailable

Поставьте language server, например:

```bash
npm install -g typescript-language-server typescript
```

Затем `mookacode doctor` и `lspServers` в конфигурации.

## MCP server failed

- `mookacode doctor` покажет ошибку сервера.
- Проверьте, что команда существует и её переменные окружения заданы.
- Проектные MCP-серверы требуют `mookacode config trust`.
- Убедитесь, что сервер говорит на ожидаемом транспорте (stdio/http/sse).

## Git checkpoint restore conflicts

Checkpoint создаётся через `git stash create` и скрытый ref, restore применяет снимок без перезаписи истории. При конфликте с локальными изменениями закоммитьте или спрячьте их и повторите. `git reset --hard` автоматически не выполняется никогда.

## Permission denied in non-interactive runs

One-shot запуск без TTY не может ответить на запрос подтверждения. Задайте permissions явно в конфигурации или запускайте интерактивно. Опасные действия по умолчанию требуют `ask`.

## Windows path confusion / temp folders

Workspace root нормализуется через `realpath`, поэтому 8.3-короткие пути (`99E7~1`) и junctions обрабатываются корректно. Если сессия ссылается на другую форму пути — запустите её из корня проекта.

## Where are logs?

Диагностика: `mookacode doctor --verbose`. Сессии и история лежат в `~/.mookacode` (или в `MOOKACODE_HOME`). Секреты в выводе редактируются.
