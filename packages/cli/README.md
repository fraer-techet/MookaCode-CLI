# mookacode

Локальный AI-агент для терминала: читает проект, правит файлы, запускает команды, работает с Git, MCP и LSP. Провайдеры — Anthropic, OpenAI, любые OpenAI-compatible endpoints и Ollama, напрямую.

```bash
npm install -g mookacode
mookacode auth set anthropic
mookacode "найди причину падения тестов и исправь"
```

Требуется Node.js 20.11+.

## Команды

```text
mookacode                        интерактивная сессия
mookacode "task"                 выполнить задачу
mookacode --mode plan "task"     plan | build | debug | ask | review
mookacode --effort high "task"   auto | low | medium | high
mookacode --continue             продолжить последнюю сессию
mookacode models                 модели и статус ключей
mookacode providers              провайдеры, add/edit/remove/probe
mookacode auth status|set|remove ключи в OS credential store
mookacode config show|get|set    конфигурация и trust
mookacode sessions               история, restore checkpoint
mookacode doctor                 диагностика
```

Полная документация, конфигурация и политика безопасности — в [репозитории](https://github.com/fraer-techet/mookacode).

## Лицензия

MIT
