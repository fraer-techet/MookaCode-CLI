# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [Semantic Versioning](https://semver.org/lang/ru/).

## [0.1.0] — 2026-10-26

Первый публичный релиз CLI.

### Added

- Агентский цикл: потоковые ответы, последовательные tool calls, лимиты итераций и времени, отмена, восстановление прерванной сессии.
- Инструменты: чтение/запись/правка файлов с SHA-256 защитой от конфликтов, поиск по коду, команды оболочки, Git, диагностика LSP, веб-поиск, память проекта.
- Режимы `plan`, `build`, `debug`, `ask`, `review` с разными наборами инструментов.
- Провайдеры Anthropic, OpenAI, Ollama и произвольные OpenAI-compatible endpoints; несколько моделей на провайдера, свои headers, ключ из env, `providers probe`.
- `effort` (`auto|low|medium|high`) с маппингом в `reasoning_effort`, thinking budget Anthropic и общий бюджет вывода.
- Permissions `allow` / `ask` / `deny` по категориям, правила команд, подтверждения в TUI.
- Сессии: JSON-хранилище, `--continue`, `--session`, resume, restore Git-checkpoint без перезаписи истории.
- Контекст: `AGENTS.md`/`CLAUDE.md`, память проекта, оценка токенов, компакция, дедупликация результатов инструментов.
- MCP (stdio/HTTP/SSE) с allowlist инструментов и LSP-диагностика.
- Субагенты explore/review с ограниченным набором инструментов.
- Ключи в OS credential store: Windows DPAPI, macOS Keychain, Linux Secret Service, AES-GCM fallback.
- Интерактивный TUI: история ввода, автодополнение, слэш-команды, питомец-компаньон.
- Диагностика: `mookacode doctor`, `mookacode auth status`, `mookacode models --json`.
- Сборка в один CJS-бандл, установщики для Windows и Linux/macOS, GitHub Actions CI и release workflow.

### Known limitations

- Нет OS-level sandbox: команды выполняются с правами пользователя.
- LSP требует установленного language server.
- Веб-поиск использует DuckDuckGo HTML без ключа или Brave при `BRAVE_SEARCH_API_KEY`; DuckDuckGo может ограничивать запросы.
- Стоимость в USD показывается только при заданных тарифах и без неопределённости по cache-токенам.
