# 04 — Текущее состояние

## Версия

**V100** — 2026-06-11

## Реализовано и работает стабильно

- [x] Electron-каркас: main-процесс, preload, renderer
- [x] Single-instance lock — предотвращение запуска нескольких копий
- [x] 3 overlay-окна: toolbar, suggestion, transcript
- [x] Hash-based роутинг: `#/toolbar`, `#/suggestion`, `#/transcript`
- [x] Overlay-настройки: alwaysOnTop, transparent, frameless, skipTaskbar
- [x] Mouse passthrough: `setIgnoreMouseEvents(true, {forward: true})`
- [x] Drag-to-move для toolbar
- [x] Прозрачность окон через `setOpacity()`
- [x] Настройки: electron-store, типобезопасный CRUD
- [x] Панель настроек (SettingsPanel): API ключи, провайдер STT, модель, opacity, width
- [x] IPC-мост: contextBridge + CopilotApi тип
- [x] Аудио-захват: WASAPI loopback (win-audio-capture) для Windows
- [x] Аудио-захват: ffmpeg fallback для macOS и Linux
- [x] Аудио-конвертация: резэмплирование + миксdown в 16kHz Mono 16-bit PCM
- [x] Нарезка чанков: 6 секунд, ChunkBuffer с накоплением
- [x] STT-сервис: очередь чанков, последовательная обработка
- [x] STT-сервис: PCM → WAV конвертация (44-байтный заголовок)
- [x] STT-сервис: multipart/form-data ручная сборка (без npm-зависимостей)
- [x] STT-сервис: Groq Whisper API (whisper-large-v3, language=ru)
- [x] STT-сервис: OpenAI Whisper API (whisper-1, language=ru)
- [x] STT-сервис: трансляция результатов через IPC transcription:update
- [x] STT-сервис: накопление текста созвона для контекста LLM
- [x] OpenRouter-сервис: streaming SSE с AbortController
- [x] OpenRouter-сервис: системный промпт 1С (архитектор, БСП, краткие подсказки, Markdown)
- [x] OpenRouter-сервис: авто-подсказки при паузе (2с после последней транскрипции)
- [x] OpenRouter-сервис: ручной запрос подсказки
- [x] OpenRouter-сервис: прерывание стриминга
- [x] OpenRouter-сервис: история последних 3 подсказок для контекста
- [x] OpenRouter-сервис: обрезка контекста до 12000 символов
- [x] Пайплайн audioCapture → sttService → openrouterService (настроен в handlers.ts)
- [x] TranscriptPanel: отображение расшифровки, подписка на IPC
- [x] SuggestionPanel: отображение подсказок, кнопки «Спросить ИИ» / «Стоп»
- [x] Toolbar: кнопки «Слушать»/«Стоп», «Подсказки», «Текст», «Настройки»
- [x] Material Dark CSS-тема с glass-morphism

## История версий

**V100**: Начальная реализация Step 3 — полная интеграция реальных сервисов. Аудио-захват (WASAPI + ffmpeg fallback), STT (Groq/OpenAI Whisper), OpenRouter (streaming SSE). Пайплайн capture→transcribe→suggest настроен в handlers.ts. Все IPC-каналы подключены. UI-панели функциональны.

## Не реализовано

- [ ] Горячие клавиши (global shortcuts) для старта/останова записи
- [ ] Системный трей (system tray) — сворачивание в трей
- [ ] Markdown-рендеринг в SuggestionPanel (сейчас — plain text с mono-шрифтом)
- [ ] Обнаружение голосовой активности (VAD) — сейчас отправляются все чанки, включая тишину
- [ ] Логирование в файл — сейчас только console.log
- [ ] Автообновление (electron-updater)
- [ ] Упаковка в установщик (electron-builder / electron-forge)
- [ ] Тесты (unit / integration)
- [ ] CI/CD пайплайн
- [ ] Список доступных аудио-устройств (выбор микрофона/динамика)
- [ ] Ручной выбор модели OpenRouter через UI (сейчас — текстовое поле)
- [ ] Индикатор состояния аудио-захвата на тулбаре (кроме точки)
- [ ] Счётчик отправленных/обработанных чанков для диагностики
- [ ] Восстановление позиции окон при перезапуске
- [ ] Множественные мониторы — привязка overlay к конкретному дисплею
