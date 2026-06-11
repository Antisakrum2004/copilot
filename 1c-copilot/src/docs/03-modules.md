# 03 — Модули проекта

## Main-процесс (Node.js)

### `src/main/index.ts` — 33 строк, 0.8 KB

**Ответственность**: Точка входа Electron-приложения. Запрос single-instance lock (предотвращает запуск нескольких копий), инициализация окон и IPC при `app.whenReady()`.

**Ключевые функции**:
- `app.requestSingleInstanceLock()` — блокировка второго экземпляра
- `app.whenReady().then(...)` — создание окон и регистрация IPC
- Обработка `second-instance` — восстановление окна при повторном запуске
- Обработка `window-all-closed` — выход из приложения (кроме macOS)

**Связи**: вызывает `registerIpcHandlers()` и `createMainWindows()` из handlers.ts

**Добавлено**: V100

---

### `src/main/ipc/handlers.ts` — 341 строка, 11.1 KB

**Ответственность**: Центральный реестр IPC-обработчиков. Создание 3 overlay-окон, настройка пайплайна audio→STT→LLM, все `ipcMain.handle()` и `ipcMain.on()`.

**Ключевые функции**:
- `createMainWindows(preloadPath)` — создаёт toolbar, suggestion, transcript окна
- `registerIpcHandlers()` — регистрирует все IPC-обработчики
- `setupAudioPipeline()` — связывает audioCapture callback → sttService → openrouterService
- `broadcast(channel, payload)` — отправка во все окна
- `sendToRenderer(win, channel, payload)` — отправка в конкретное окно
- `cleanup()` — остановка захвата и стриминга при завершении

**IPC-обработчики**:
- Settings: `settings:getAllSettings`, `settings:saveSetting`
- Window: `window:setIgnoreMouseEvents`, `window:setTransparent`, `window:moveWindow`, `window:show`, `window:hide`, `window:toggleAllVisibility`
- Audio: `audio:startStreams`, `audio:stopStreams`, `audio:startNativeLoopback`, `audio:stopNativeLoopback`, `enable-loopback-audio`, `disable-loopback-audio`
- Suggestion: `suggestion:show`, `suggestion:hide-all`, `suggestion:update-content`, `suggestion:set-opacity`, `suggestion:set-width`, `suggestion:set-height`, `suggestion:toggle-visibility`, `open-suggestion-window`, `suggestion:request`, `suggestion:abort`, `suggestion:isStreaming`
- Transcription: `transcription-update`, `transcription-clear`, `transcription:open-window`, `transcription:close-window`, `transcription:is-window-open`, `transcript:getCurrent`

**Связи**: импортирует audioCapture, sttService, openrouterService, overlayWindow, settings

**Добавлено**: V100

---

### `src/main/services/audioCapture.ts` — 424 строки, 14.5 KB

**Ответственность**: Захват аудио из двух источников — системный звук (WASAPI loopback) и микрофон. Нарезка на чанки по 6 секунд в формате 16kHz Mono 16-bit PCM.

**Ключевые функции**:
- `startCapture(source)` — запуск захвата (mic или system)
- `stopCapture(source)` — остановка захвата
- `stopAllCapture()` — остановка обоих источников
- `setChunkCallback(cb)` — установка callback для чанков
- `getCaptureState()` — текущее состояние захвата
- `createIpcChunkSender(getWindow)` — фабрика IPC-отправителя чанков
- `convertToTargetFormat(buffer, sampleRate, channels)` — резэмплирование + миксdown в моно
- `ChunkBuffer` — класс буферизации с накоплением до CHUNK_SIZE_BYTES
- `startFallbackCapture(source, chunkBuf)` — захват через ffmpeg child_process
- `startNativeLoopbackCapture()` / `stopNativeLoopbackCapture()` — WASAPI через win-audio-capture

**Глобальные переменные**:
- `captureState: {mic: boolean, system: boolean}` — состояние захвата
- `micInterval`, `systemInterval` — ID интервалов ffmpeg health-check
- `chunkCallback` — callback при накоплении чанка
- `nativeLoopback` — объект нативного модуля WASAPI
- `systemChunkBuf`, `micChunkBuf` — экземпляры ChunkBuffer

**Связи**: вызывается из handlers.ts, отправляет чанки в sttService через callback

**Добавлено**: V100

---

### `src/main/services/sttService.ts` — 307 строк, 10.1 KB

**Ответственность**: Очередь аудио-чанков, отправка на Whisper API (Groq или OpenAI), трансляция результатов через IPC.

**Ключевые функции**:
- `initSttService(getWindowFn)` — инициализация с функцией получения окна
- `enqueueChunk(source, chunk, sampleRate, channels)` — добавить чанк в очередь
- `processQueue()` — последовательная обработка очереди (не параллельно!)
- `transcribeChunk(wavBuffer, source)` — отправка на Whisper API (multipart/form-data)
- `createWavBuffer(pcmData, sampleRate, channels)` — обёртка PCM в WAV-заголовок
- `broadcastTranscription(payload)` — отправка во все окна renderer
- `getAccumulatedTranscript()` — получить накопленный текст созвона (для LLM контекста)
- `clearTranscript()` — сбросить транскрипцию
- `getQueueLength()` — длина очереди (диагностика)

**Глобальные переменные**:
- `sttQueue: SttQueueItem[]` — очередь чанков
- `isProcessing: boolean` — флаг обработки
- `accumulatedTranscript: string` — накопленный текст
- `lastTranscriptTime: number` — время последней транскрипции

**Связи**: вызывается из handlers.ts, читает настройки из settings.ts, использует типы из audioCapture.ts

**Добавлено**: V100

---

### `src/main/services/openrouterService.ts` — 292 строки, 11.4 KB

**Ответственность**: Streaming LLM через OpenRouter API. Генерация подсказок по 1С на основе накопленной транскрипции.

**Ключевые функции**:
- `initOpenRouterService(getWindowFn)` — инициализация
- `streamSuggestion(customTranscript?)` — основной стриминг-запрос к OpenRouter
- `abortStream()` — прерывание текущего стриминга (AbortController)
- `triggerAutoSuggestion()` — авточто-отправка при паузе (2с таймер)
- `manualSuggestion()` — ручной запрос
- `isStreamingActive()` — состояние стриминга
- `clearSuggestionHistory()` — сброс истории
- `trimContext(text)` — обрезка контекста до 12000 символов
- `broadcastSuggestion(payload)` — отправка подсказки во все окна

**Глобальные переменные**:
- `isStreaming: boolean` — флаг активного стриминга
- `streamAbortController: AbortController | null` — контроллер прерывания
- `suggestionHistory: Array<{role, content}>` — последние 3 подсказки
- `autoSendTimer` — таймер авто-отправки

**Связи**: вызывается из handlers.ts, читает транскрипцию из sttService, читает настройки из settings.ts

**Добавлено**: V100

---

### `src/main/store/settings.ts` — 23 строки, 0.6 KB

**Ответственность**: Обёртка над electron-store для CRUD настроек приложения.

**Ключевые функции**:
- `getAllSettings()` — вернуть все настройки (merged с DEFAULT_SETTINGS)
- `saveSetting(key, value)` — сохранить одну настройку
- `getSetting(key)` — прочитать одну настройку

**Связи**: используется handlers.ts, sttService.ts, openrouterService.ts, overlayWindow.ts

**Добавлено**: V100

---

### `src/main/windows/overlayWindow.ts` — 105 строк, 3.0 KB

**Ответственность**: Фабрика overlay-окон (toolbar, suggestion, transcript). Настройки прозрачности, alwaysOnTop, frameless, mouse passthrough.

**Ключевые функции**:
- `createOverlayWindow(kind, preloadPath, hash)` — создать окно заданного типа
- `applyOverlayMousePassthrough(win, ignore, forward)` — вкл/выкл сквозных кликов
- `moveWindowByDelta(win, dx, dy)` — перемещение окна на дельту
- `baseOverlayOptions(preloadPath, size)` — базовые настройки BrowserWindow
- `overlayWebPreferences(preloadPath)` — webPreferences с contextIsolation

**Связи**: вызывается из handlers.ts, читает overlayWidth и overlayOpacity из settings.ts

**Добавлено**: V100

---

## Shared

### `src/shared/ipc.ts` — 94 строки, 2.7 KB

**Ответственность**: Общие константы IPC-каналов, типы настроек и payload'ов, DEFAULT_SETTINGS.

**Ключевые экспорты**:
- `IPC` — объект с именами всех каналов (audio, transcription, suggestion, window, settings)
- `AppSettings` — тип настроек (openRouterApiKey, openRouterModel, sttApiKey, sttProvider, overlayOpacity, overlayWidth)
- `DEFAULT_SETTINGS` — дефолтные значения настроек
- `TranscriptionUpdatePayload` — тип транскрипции (text, speaker, isFinal, timestamp)
- `SuggestionUpdatePayload` — тип подсказки (content, streaming)
- `AudioChunkPayload` — тип аудио-чанка (data, sampleRate, channels)
- `IgnoreMouseEventsOptions` — тип для mouse passthrough

**Связи**: импортируется всеми модулями main-процесса, preload, renderer

**Добавлено**: V100

---

## Preload

### `src/preload/index.ts` — 132 строки, 5.9 KB

**Ответственность**: Preload-скрипт. Создаёт типобезопасный IPC-мост через `contextBridge.exposeInMainWorld('copilot', api)`.

**Ключевые элементы**:
- `CopilotApi` — тип всего API, доступного в renderer
- `subscribe<T>(channel, cb)` — вспомогательная функция для `ipcRenderer.on` с отпиской
- `api` — объект с методами для settings, window, audio, transcription, suggestion

**Связи**: использует IPC-каналы из @shared/ipc

**Добавлено**: V100

---

## Renderer (React)

### `src/renderer/src/App.tsx` — 56 строк, 1.8 KB

**Ответственность**: Hash-based роутер. Определяет маршрут по `window.location.hash` и рендерит соответствующий компонент.

**Ключевые функции**:
- `getRouteFromHash()` — парсинг хеша: `#/toolbar`, `#/suggestion`, `#/transcript`
- `toggleRecording()` — старт/стоп аудио-захвата

**Связи**: рендерит Toolbar, SuggestionPanel, TranscriptPanel, SettingsPanel

**Добавлено**: V100

---

### `src/renderer/src/components/Toolbar.tsx` — 94 строки, 3.1 KB

**Ответственность**: Тулбар — кнопки управления (Слушать/Стоп, Подсказки, Текст, Настройки). Drag-to-move.

**Ключевые элементы**:
- Drag через `onMouseDown` + `window.addEventListener('mousemove')` + `window.copilot.window.moveWindow(dx, dy)`
- Кнопка «Слушать»/«Стоп» с индикатором (зелёная точка при записи)

**Связи**: вызывает `window.copilot.audio.*`, `window.copilot.suggestion.*`, `window.copilot.transcription.*`

**Добавлено**: V100

---

### `src/renderer/src/components/SuggestionPanel.tsx` — 102 строки, 3.3 KB

**Ответственность**: Панель подсказок 1С. Подписка на `suggestion:update-content`, кнопки «Спросить ИИ» / «Стоп».

**Ключевые элементы**:
- Подписка на `window.copilot.suggestion.onContentUpdate` — обновление контента
- `streaming` флаг — бейдж «stream» и кнопка «Стоп» / «Спросить ИИ»
- Mono-шрифт для отображения Markdown

**Связи**: вызывает `window.copilot.suggestion.request()`, `window.copilot.suggestion.abort()`

**Добавлено**: V100

---

### `src/renderer/src/components/TranscriptPanel.tsx` — 86 строк, 2.6 KB

**Ответственность**: Панель расшифровки. Список строк с speaker-метками (MIC / SYSTEM).

**Ключевые элементы**:
- Подписка на `window.copilot.transcription.onUpdate` — добавление строк
- Подписка на `window.copilot.transcription.onClear` — очистка
- Ограничение: хранятся последние 200 строк (`slice(-200)`)

**Связи**: вызывает `window.copilot.transcription.clear()`

**Добавлено**: V100

---

### `src/renderer/src/components/SettingsPanel.tsx` — 182 строки, 5.2 KB

**Ответственность**: Панель настроек. API ключи, провайдер STT, модель LLM, прозрачность и ширина оверлея.

**Ключевые элементы**:
- Загрузка настроек через `window.copilot.settings.getAll()`
- Пошаговое сохранение через `window.copilot.settings.save(key, value)`
- Применение opacity и width через `window.copilot.suggestion.setOpacity/setWidth`

**Связи**: вызывает `window.copilot.settings.*`, `window.copilot.suggestion.*`

**Добавлено**: V100

---

### `src/renderer/src/styles/theme.css` — 52 строки, 1.5 KB

**Ответственность**: CSS-переменные. Material Dark палитра, glass-morphism переменные, spacing, typography.

**Добавлено**: V100

---

### `src/renderer/src/styles/global.css` — 95 строк, 1.9 KB

**Ответственность**: Глобальные стили. Reset, glass-panel, glass-card, кнопки (btn-primary, btn-ghost), scroll-y, mono.

**Добавлено**: V100

---

## Конфигурация

### `electron.vite.config.ts` — 27 строк, 0.6 KB

**Ответственность**: Конфигурация electron-vite. Алиасы `@shared` → `src/shared`, `@renderer` → `src/renderer/src`. ExternalizeDeps для main и preload.

**Добавлено**: V100

---

### `package.json` — 30 строк, 0.8 KB

**Ответственность**: Зависимости и скрипты проекта. NPM-скрипты: `dev`, `build`, `preview`, `typecheck`.

**Добавлено**: V100
