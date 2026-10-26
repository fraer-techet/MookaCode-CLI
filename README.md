# MookaCode

[![CI](https://github.com/fraer-techet/mookacode/actions/workflows/ci.yml/badge.svg)](https://github.com/fraer-techet/mookacode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mookacode.svg)](https://www.npmjs.com/package/mookacode)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](package.json)

**MookaCode** — локальный AI-агент для терминала. Он читает ваш проект, правит файлы, запускает команды, проверяет diff, работает с Git, MCP и LSP. Модели подключаются напрямую: Anthropic, OpenAI, любые OpenAI-compatible endpoints и локальная Ollama — без прокси и облачного аккаунта.

```text
$ mookacode "найди причину падения тестов и исправь"

● plan · claude-sonnet-4-5 · ~/src/api
  read_file    src/auth/session.ts
  search_text  "expiresAt"
  edit_file    src/auth/session.ts  (+4 −2)
  run_command  pnpm test
✓ 1 файл изменён, тесты проходят
```

> Статус: `0.1.0` — ранняя, но рабочая версия. Ядро, агентский цикл, инструменты, провайдеры, permissions, сессии, Git, MCP и LSP реализованы и покрыты тестами. Основная проверка — Windows 11; Linux и macOS собираются и проходят smoke-тесты в CI.

## Возможности

- **Агентский цикл** — потоковые ответы, последовательное выполнение инструментов, лимиты итераций/времени, отмена по `Ctrl+C`, восстановление прерванной сессии.
- **Инструменты** — чтение и запись файлов, точные правки с SHA-256 защитой от конфликтов, поиск по коду, команды оболочки, Git, диагностика LSP, веб-поиск, память проекта.
- **Режимы** — `plan` (только исследование), `build`, `debug`, `ask`, `review`; набор инструментов и поведение зависят от режима.
- **Провайдеры** — Anthropic, OpenAI, Ollama и любые OpenAI-compatible серверы; несколько моделей на провайдера, свои headers и `api-key` из env; `effort` (`auto|low|medium|high`) для reasoning-моделей.
- **Permissions** — `allow` / `ask` / `deny` для чтения, записи, команд, сети, Git и MCP; опасные команды требуют подтверждения.
- **Сессии** — история в JSON, `--continue`, `--session`, resume после ошибки, restore Git-checkpoint без перезаписи истории.
- **Контекст** — `AGENTS.md` / `CLAUDE.md`, память проекта, оценка токенов, компакция старых ходов, дедупликация результатов инструментов.
- **MCP и LSP** — stdio / HTTP / SSE MCP-серверы с allowlist инструментов, диагностика от language server.
- **Субагенты** — read-only специалисты (explore/review) с ограниченным набором инструментов, не более двух одновременно.
- **Безопасность** — ключи в OS credential store, workspace-guard против `..` и symlink-побегов, редакция секретов в сессиях, памяти и логах.

## Установка

Нужен Node.js **20.11+**.

### npm

```bash
npm install -g mookacode
mookacode --version
```

Без глобальной установки:

```bash
npx mookacode "объясни структуру проекта"
```

### Готовый бандл из Releases

Каждый релиз публикует один самодостаточный файл `mookacode.cjs` и контрольные суммы:

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/fraer-techet/mookacode/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/fraer-techet/mookacode/main/install.ps1 | iex
```

Скрипты скачивают последний релиз, проверяют SHA-256 и ставят обёртку `mookacode` в `~/.local/bin` (Linux/macOS) или `%LOCALAPPDATA%\MookaCode\bin` (Windows). Нужен только Node.js — Rust, компиляторы и права администратора не требуются.

### Из исходников

```bash
git clone https://github.com/fraer-techet/mookacode.git
cd mookacode
pnpm install
pnpm build

# Linux / macOS
bash scripts/install-cli.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
```

Либо запускайте бандл напрямую: `node packages/cli/dist/mookacode.cjs`.

## Быстрый старт

```bash
mookacode auth set anthropic          # ключ в OS credential store
mookacode "найди причину падения тестов и исправь"
mookacode                            # интерактивный режим
```

Ключ можно задать переменной окружения — она имеет приоритет над хранилищем:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

Локальная модель через Ollama (ключ не нужен):

```bash
mookacode --provider ollama --model qwen2.5-coder:7b "добавь пагинацию в список задач"
```

## Команды

| Команда                                        | Назначение                                            |
| ---------------------------------------------- | ----------------------------------------------------- |
| `mookacode`                                    | интерактивная сессия                                  |
| `mookacode "task"`                             | выполнить одну задачу и выйти                         |
| `mookacode --continue ["task"]`                | продолжить последнюю сессию                           |
| `mookacode --session <id> "task"`              | продолжить конкретную сессию                          |
| `mookacode --model <model>`                    | выбрать модель                                        |
| `mookacode --provider <provider>`              | выбрать провайдера                                    |
| `mookacode --mode <mode>`                      | `plan` \| `build` \| `debug` \| `ask` \| `review`     |
| `mookacode --effort <level>`                   | `auto` \| `low` \| `medium` \| `high`                 |
| `mookacode --max-iterations <n>`               | лимит шагов агента на запуск                          |
| `mookacode --show-reasoning`                   | показывать reasoning-дельты, если провайдер их отдаёт |
| `mookacode models [--json]`                    | модели и статус ключей                                |
| `mookacode providers [list]`                   | список провайдеров                                    |
| `mookacode providers add ...`                  | добавить endpoint, модели, headers                    |
| `mookacode providers edit --id <id>`           | изменить endpoint, модели, headers                    |
| `mookacode providers remove <id>`              | удалить провайдера                                    |
| `mookacode providers default <id> [model]`     | провайдер/модель по умолчанию                         |
| `mookacode providers probe <id>`               | проверить соединение и ключ                           |
| `mookacode setup`                              | мастер настройки провайдера и ключа                   |
| `mookacode config [show]`                      | эффективная конфигурация                              |
| `mookacode config get/set/init`                | чтение, запись, создание конфигурации                 |
| `mookacode config trust/untrust`               | доверие проектным настройкам                          |
| `mookacode auth [status]`                      | backend хранилища и сохранённые ключи                 |
| `mookacode auth set/remove <provider>`         | сохранить или удалить ключ                            |
| `mookacode sessions [list]`                    | история сессий                                        |
| `mookacode sessions show <id>`                 | содержимое сессии                                     |
| `mookacode sessions delete <id>`               | удалить сессию                                        |
| `mookacode sessions restore <id> [checkpoint]` | применить Git-checkpoint                              |
| `mookacode doctor [--verbose]`                 | диагностика окружения и интеграций                    |
| `mookacode --pet`                              | показать питомца-компаньона и выйти                   |

## Интерактивный режим

Внутри сессии доступны слэш-команды: `/help`, `/model`, `/provider`, `/mode`, `/effort`, `/diff`, `/status`, `/permissions`, `/sessions`, `/resume`, `/continue`, `/compact`, `/init`, `/new`, `/clear`, `/pet`, `/quit`.

Есть история ввода, автодополнение команд и подтверждения разрешений прямо в терминале.

## Провайдеры

```bash
# Anthropic / OpenAI
mookacode auth set anthropic
mookacode auth set openai

# Ollama
mookacode --provider ollama --model qwen2.5-coder:7b "task"

# Любой OpenAI-compatible endpoint
mookacode providers add --id local --type custom --base-url http://127.0.0.1:8080/v1 \
  --model model-a,model-b --headers "X-Org: team; X-Api-Version: 2024-01" \
  --api-key-env LOCAL_KEY --default
mookacode providers probe local

# Пошаговый мастер
mookacode setup
```

MookaCode проверяет объявленные возможности модели (`supportsTools`, `supportsStreaming`) и предупреждает о несовместимости вместо тихого сбоя.

## Конфигурация

- Глобально: `~/.mookacode/config.json` (переопределяется `MOOKACODE_HOME`).
- Проект: `.mookacode/config.json` — применяется только после `mookacode config trust`.
- Инструкции: `AGENTS.md`, `CLAUDE.md`, `.mookacode/instructions.md`.
- Память проекта: `.mookacode/memory.json`.

Переменные окружения: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOOKACODE_HOME`, `MOOKACODE_ALLOW_LOCAL_NETWORK`, `BRAVE_SEARCH_API_KEY`.

Полный справочник: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Безопасность

- Ключи хранятся в Windows DPAPI; на macOS — Keychain, на Linux — Secret Service, иначе локальный AES-GCM fallback с правами `0600`.
- Инструменты ограничены workspace: `..`, абсолютные пути и symlink/junction-побеги блокируются.
- `allow` / `ask` / `deny` для чтения, записи, команд, сети, Git и MCP.
- Проектные настройки, MCP-серверы и агенты не применяются до `config trust`.
- Секреты вырезаются из сессий, памяти, экспорта конфигурации и сообщений об ошибках.
- **OS-sandbox отсутствует.** Команды выполняются с правами пользователя, permissions — это политика, а не изоляция.

Подробнее: [docs/SECURITY.md](docs/SECURITY.md). Об уязвимостях — [.github/SECURITY.md](.github/SECURITY.md).

## Архитектура

```text
mookacode (CLI, TypeScript)
   │
   ├── @mookacode/core ── providers · tools · permissions · agent
   │                       sessions · context · memory · Git · LSP · MCP
   └── @mookacode/protocol — общие типы и события
```

CLI запускает Core в том же процессе и собирается в один CJS-бандл через esbuild. Никакого локального HTTP-сервера и фоновых демонов.

Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Разработка

```bash
pnpm install
pnpm dev          # запуск CLI из исходников
pnpm typecheck
pnpm lint
pnpm test
pnpm build        # packages/cli/dist/mookacode.cjs
pnpm smoke        # проверка собранного бандла
pnpm verify       # всё сразу
```

Структура репозитория:

```text
packages/cli        TUI, readline, prompts, команды, ANSI-рендерер
packages/core       config/auth, providers, agent, tools, permissions,
                    sessions, context/memory, Git, LSP, MCP, subagents
packages/protocol   общие типы, события, RPC-структуры
docs                архитектура, конфигурация, безопасность, тесты
scripts             сборка, smoke-тесты, установка
```

Тесты покрывают агентский цикл, потоковые tool calls, адаптеры Anthropic/OpenAI, permissions, отмену, файловые инструменты, сессии и resume, компакцию контекста, вложенные `.gitignore`, Git-checkpoint и реальный stdio MCP.

## Участие

Issues и pull requests приветствуются. Перед PR прогоните `pnpm verify`. Детали: [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).
