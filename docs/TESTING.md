# Testing

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
pnpm verify   # всё перечисленное по порядку
```

`pnpm test` — Vitest, файлы лежат в `packages/*/test`. Тесты не ходят в сеть: провайдеры эмулируются fake OpenAI-compatible SSE-сервером (`packages/core/test/helpers/fake-openai.ts`), домашний каталог подменяется через `MOOKACODE_HOME`.

`pnpm smoke` проверяет собранный бандл: `--help`, `--version` (сверяется с `packages/cli/package.json`), `models`, `doctor`.

## Automated coverage

- агентский цикл с потоковым tool call, созданием файла и сохранением сессии;
- отказ в permission и отсутствие изменений на диске;
- ответ провайдера 401 и resumable-сессия;
- отмена и статус `interrupted`;
- точный `edit_file` и unified diff;
- workspace traversal, абсолютные пути, symlink/junction-побеги;
- вложенные `.gitignore`;
- компакция контекста с сохранением текущей задачи;
- resume сессии после перезапуска процесса и редакция секретов;
- project trust;
- Git status/diff/checkpoint;
- реальный stdio MCP-сервер (list/call);
- Anthropic SSE адаптер (текст, tool use, cache usage, stop reason);
- геометрия питомца (одинаковая видимая ширина строк) и truecolor-палитра.

## CI

`.github/workflows/ci.yml` гоняет `typecheck`, `lint`, `test`, `build` и `smoke` на Ubuntu, Windows и macOS. Релизный workflow дополнительно проверяет, что тег совпадает с версией в `packages/cli/package.json`.

## Gaps

- LSP-диагностика требует установленного language server — фикстура в репозиторий не входит.
- Нет автоматического E2E против реальных Anthropic/OpenAI API (нужны ключи и деньги).
- Производительность на Linux/macOS измеряется вручную, в CI только smoke.
