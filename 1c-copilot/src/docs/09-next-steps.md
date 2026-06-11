# 09 — Следующие шаги

## Приоритет 0 — Проект не запускается → ✅ ВЫПОЛНЕНО (ЭТАП 1)

- [x] **Создать `tsconfig.node.json`** — для main + preload (target: ES2022, module: ESNext, node окружение)
- [x] **Создать `tsconfig.web.json`** — для renderer (target: ES2020, module: ESNext, DOM окружение, JSX)
- [x] **Выполнить `npm install`** — установить все 12 зависимостей
- [x] **Запустить `electron-vite build`** — проверить что проект компилируется
- [x] **Исправить ошибки компиляции** — неизбежно будут после первой сборки
- [x] **Запустить `electron-vite dev`** — первый запуск приложения (компиляция ОК, GUI не запускается на сервере — ожидаемо)

## Приоритет 1 — Критические баги в коде → ✅ ЧАСТИЧНО ВЫПОЛНЕНО (ЭТАП 2)

- [x] **Исправить WASAPI dead code** в audioCapture.ts — `loadNativeLoopback()` теперь вызывается ДО проверки `nativeLoopback` в `startCapture('system')`
- [x] **Сохранять ffmpeg child process** — добавлены `ffmpegMicProcess`/`ffmpegSystemProcess` на уровне модуля, `killFfmpegProcess()` с SIGKILL
- [x] **Проверять результат startFallbackCapture** в startCapture — возвращается `false` если ffmpeg не запустился
- [x] **Добавить `app.on('before-quit', cleanup)`** в index.ts — cleanup() импортирован из handlers.ts
- [ ] **Удалить дублирующую отправку** в sttService.ts `broadcastTranscription` — убрать getWindow() вызов, оставить только getAllWindows()
- [ ] **Исправить suggestionHistory** в openrouterService.ts — хранить пары user/assistant, а не только assistant

## Приоритет 2 — Первый реальный запуск

- [ ] **Протестировать с Groq API** — получить ключ, запустить захват, проверить транскрипцию
- [ ] **Протестировать с OpenRouter API** — проверить streaming подсказок
- [ ] **Протестировать ffmpeg fallback** — проверить что микрофон захватывается
- [ ] **Проверить fetch() с Buffer body** — если не работает, заменить на Uint8Array
- [ ] **Заменить хардкод-строки IPC** в handlers.ts на IPC-константы

## Приоритет 3 — Базовая функциональность

- [ ] **Markdown-рендеринг** в SuggestionPanel (react-markdown)
- [ ] **Горячие клавиши** (global shortcuts) для старта/останова
- [ ] **Системный трей** — сворачивание вместо закрытия
- [ ] **Редактор системного промпта** в настройках
- [ ] **Настройка temperature/max_tokens** в UI

## Приоритет 4 — Чистка / рефакторинг

- [ ] Вынести inline-стили в CSS Modules
- [ ] Включить TypeScript strict mode
- [ ] Единый логгер с записью в файл
- [ ] Удалить pkg/ директорию или синхронизировать
- [ ] VAD (Voice Activity Detection) — не отправлять тишину на STT

## Приоритет 5+ — Будущее

- [ ] electron-builder упаковка
- [ ] Автообновление (electron-updater)
- [ ] Тесты
- [ ] CI/CD
- [ ] Множественные мониторы
- [ ] Выбор аудио-устройств
