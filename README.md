OpenAI Smart Commit

Генерация Jira Smart Commit‑сообщений из VS Code через OpenAI. Поддерживает Jira Server/Cloud, выбор задачи Jira, многстрочные комментарии, авто‑оценку времени и (опционально) «умный» двухпроходный режим (Holistic Mode).

Содержание
- Возможности
- Две версии: 0.3.4 (classic) и 0.4.0 (holistic)
- Установка (VSIX)
- Настройка
- Как это работает
- Оценка #time
- Jira интеграция
- Отладка
- Безопасность

Возможности
- Кнопка в Source Control: Generate Smart Commit (OpenAI).
- Jira Quick Pick: список назначенных задач + «Enter key…» + «Skip».
- Jira Smart Commit формат:
  - Заголовок: [ISSUE‑KEY ]type(scope): subject (EN)
  - Комментарии: одна или несколько строк `#comment …` (RU)
  - Время: единичный тег `#time …` (локальная авто‑оценка, максимум 8h)
- `#in-progress` не используется.
- Учитывает staged + unstaged + новые файлы (есть авто‑stage).
- Детализация комментария: brief / normal / detailed + принудительное «дотягивание» при необходимости.

Две версии
- 0.3.4 — Classic (single‑pass)
  - Один запрос к модели, многострочный `#comment`, один `#time`.
  - Файл: `openai-smart-commit-0.3.4.vsix`
- 0.4.0 — Holistic (two‑pass)
  - Проход 1: LLM анализирует все изменения и возвращает JSON (type/scope/subject_en/комментарии).
  - Проход 2: из JSON собирается итоговый коммит.
  - Вкл/Выкл: настройка `openaiSmartCommit.holisticMode`.
  - Файл: `openai-smart-commit-0.4.0.vsix`.

Установка (VSIX)
1) VS Code → Extensions → «…» → Install from VSIX → выберите `.vsix` из папки проекта.
2) Перезагрузите окно: Command Palette → `Developer: Reload Window`.

Настройка
- OpenAI
  - `openaiSmartCommit.apiKey` или переменная окружения `OPENAI_API_KEY`
  - `openaiSmartCommit.model`: `gpt-4o-mini`
  - `openaiSmartCommit.endpoint`: `https://api.openai.com/v1/chat/completions`
  - `openaiSmartCommit.maxTokens`: 512–1024; `temperature`: 0.2–0.3
- Jira
  - `openaiSmartCommit.issuePicker`: true (всегда предлагает выбрать задачу / ввести ключ / пропустить)
  - `openaiSmartCommit.jira.baseUrl`: адрес вашей Jira (Server/Cloud)
  - `openaiSmartCommit.jira.apiToken`: PAT/токен (или команда `OpenAI Smart Commit: Set Jira API Token` для SecretStorage)
  - `openaiSmartCommit.jira.jql`, `openaiSmartCommit.jira.maxIssues`
- Diff/Git
  - `openaiSmartCommit.autoStage`: `off` | `new` | `all` (по умолчанию all)
  - `openaiSmartCommit.includeUntracked`: `auto` | `always` | `never` (по умолчанию always)
- Комментарии
  - `openaiSmartCommit.commentDetail`: `brief` | `normal` | `detailed`
  - `openaiSmartCommit.enforceDetailedComment`: true/false
  - `openaiSmartCommit.minCommentWordsNormal` / `openaiSmartCommit.minCommentWordsDetailed`
- Режимы
  - `openaiSmartCommit.holisticMode`: on/off (двухпроходный анализ)

Как это работает
1) Собирается контекст: ветка, выбранная Jira‑задача (при наличии), список путей (staged + unstaged + новые), объединённый diff.
2) (Опция) Holistic mode:
   - Проход 1: модель возвращает JSON `{ type, scope, subject_en, comment_ru }`.
   - Проход 2: формируется заголовок и многострочный `#comment` без перечисления конкретных файлов/окружений.
3) Локально рассчитывается `#time` и подставляется последней строкой; любые чужие теги приводятся к виду `#comment`/`#time`.

Оценка `#time`
- Считаются строки `+`/`-` в объединённом diff (staged + unstaged + новые).
- База: 0–20 → 15m; 21–50 → 30m; 51–100 → 45m; 101–200 → 1h; 201–400 → 2h; >400 → 4h.
- Множители по типу: ci/docs/test ×0.8; chore ×0.9; fix ×1.0; refactor ×1.1; infra ×1.2; feat ×1.5.
- Округление к 15m; минимум 15m; максимум 8h.

Jira интеграция
- Quick Pick: задачи по JQL `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`.
- Авторизация Server/DC: Bearer `<PAT>`.
- Команда `OpenAI Smart Commit: Set Jira API Token` — безопасное хранение токена в SecretStorage VS Code.
- В holistic‑режиме подтягивается summary задачи для улучшения контекста.

Отладка
- View → Output → `OpenAI Smart Commit` — диагностические сообщения (ошибки Jira, ответы модели).
- Если список задач не появляется — проверьте `jira.baseUrl` и что используется Bearer token.
- Если комментарии короткие — включите `Enforce Detailed Comment` и увеличьте `minCommentWordsDetailed`; поднимите `maxTokens`.

Безопасность
- Ключи/токены не хранятся в коде расширения.
- Рекомендуется: `OPENAI_API_KEY` (env) и `JIRA_API_TOKEN` (через команду/SecretStorage), а не хранение в JSON‑настройках.

Лицензия
- MIT

