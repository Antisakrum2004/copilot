# 03 — Модули проекта

## Main-процесс (Node.js)

### `src/main/index.ts` — 41 строка, 1.1 KB

**Ответственность**: Точка входа Electron-приложения. Запрос single-instance lock, инициализация окон и IPC при `app.whenReady()`, cleanup при выходе.

**Ключевые функции**:
- `app.requestSingleInstanceLock()` — блокировка второго экземпляра
- `app.whenReady().then(...)` — создание окон и регистрация IPC
- `app.on('before-quit', cleanup)` — остановка аудио и стриминга при выходе (исправлено на ЭТАП 2)
- Обработка `second-instance` — восстановление окна при повторном запуске
- Обработка `window-all-closed` — выход из приложения (кроме macOS)

**Связи**: вызывает `registerIpcHandlers()` и `createMainWindows()` из handlers.ts, импортирует `cleanup`

---

### `src/main/ipc/handlers.ts` — 378 строк, 13.0 KB

**Ответственность**: Центральный реестр IPC-обработчиков. Создание 3 overlay-окон, настройка пайплайна audio→STT→LLM, все `ipcMain.handle()` и `ipcMain.on()`.

**Ключевые функции**:
- `createMainWindows(preloadPath)` — создаёт toolbar, suggestion, transcript окна через `createOverlayWindow()`
- `registerIpcHandlers()` — регистрирует 30+ IPC-обработчиков
- `setupAudioPipeline()` — связывает audioCapture chunkCallback → sttService.enqueueChunk + triggerAutoSuggestion
- `broadcast(channel, payload)` — отправка во все 3 окна через `BrowserWindow.getAllWindows()`
- `sendToRenderer(win, channel, payload)` — отправка в конкретное окно
- `cleanup()` — остановка захвата и стриминга при завершении

**IPC-обработчики** (30+ каналов):
- **Settings** (2): `settings:getAll`, `settings:save`
- **Window** (6): `setIgnoreMouseEvents`, `setTransparent`, `moveWindow`, `show`, `hide`, `toggleAllVisibility`
- **Audio** (12): `startStreams`, `stopStreams`, `startNativeLoopback`, `stopNativeLoopback`, `sendMicChunk`, `micCaptureStart`, `micCaptureStop`, `micChunk`, `speakerChunk`, `loopbackData/Started/Stopped/Error`, `enableLoopback`, `disableLoopback`
- **Suggestion** (9): `show`, `hideAll`, `updateContent`, `setOpacity`, `setWidth`, `setHeight`, `toggleVisibility`, `openWindow`, `request`, `abort`, `isStreaming`
- **Transcription** (6): `update`, `clear`, `openWindow`, `closeWindow`, `isWindowOpen`, `getCurrent`

**Известные баги**: 4 хардкод-строки вместо IPC-констант (`'suggestion:request'`, `'suggestion:abort'`, `'transcript:getCurrent'`, `'suggestion:isStreaming'`)

**Связи**: импортирует audioCapture, sttService, openrouterService, overlayWindow, settings

---

### `src/main/services/audioCapture.ts` — 552 строки, 18.0 KB

**Ответственность**: Захват аудио из двух источников с разделением процессов:
- **Микрофон**: Renderer-side через getUserMedia → IPC чанки → `handleMicChunkFromRenderer()` → `ChunkBuffer('mic')`
- **Системный звук**: Main-side через WASAPI Loopback (win-audio-capture) или ffmpeg fallback → `ChunkBuffer('system')`

**Ключевые экспорты**:
- `startCapture(source: AudioSource): Promise<boolean>` — запуск захвата
- `stopCapture(source: AudioSource): void` — остановка захвата
- `stopAllCapture(): void` — остановка обоих источников
- `setChunkCallback(cb: AudioChunkCallback): void` — установка callback для чанков
- `getCaptureState(): AudioCaptureState` — текущее состояние `{mic, system}`
- `handleMicChunkFromRenderer(data: ArrayBuffer): void` — приём PCM-чанков из Renderer
- `createIpcChunkSender(getWindow): AudioChunkCallback` — фабрика IPC-отправителя

**Внутренние классы и функции**:
- `ChunkBuffer` — класс буферизации с накоплением до CHUNK_SIZE_BYTES (192 000 = 6 сек). Методы: `push()`, `reset()`, `flush()`
- `convertToTargetFormat(inputBuffer, inputSampleRate, inputChannels): Buffer` — линейная интерполяция + миксдаун в моно
- `loadNativeLoopback(): void` — загрузка win-audio-capture модуля (Windows-only)
- `startNativeLoopbackCapture(): Promise<boolean>` — WASAPI loopback через WinAudioCapture CLASS
- `stopNativeLoopbackCapture(): void` — остановка WASAPI
- `startFfmpegSystemCapture(): boolean` — ffmpeg fallback для системного звука
- `killFfmpegProcess(proc, source): void` — убийство ffmpeg процесса с SIGKILL

**Глобальные переменные**:
- `captureState: {mic: boolean, system: boolean}` — состояние захвата
- `chunkCallback: AudioChunkCallback | null` — callback при накоплении чанка
- `nativeLoopback: any | null` — объект нативного модуля WASAPI
- `systemChunkBuf: ChunkBuffer | null`, `micChunkBuf: ChunkBuffer | null` — экземпляры ChunkBuffer

**Константы**:
- `SAMPLE_RATE = 16000`, `CHANNELS = 1`, `BITS_PER_SAMPLE = 16`
- `CHUNK_DURATION_MS = 6000`, `CHUNK_SIZE_BYTES = 192000`

**Известные баги**:
- Ложный `true` при spawn ffmpeg (состояние ставится в true до реальной проверки старта процесса)
- `systemChunkBuf` может быть null при повторном старте WASAPI в режиме "already running"

**Связи**: вызывается из handlers.ts, отправляет чанки в sttService через callback

---

### `src/main/services/sttService.ts` — 308 строк, 10.5 KB

**Ответственность**: Очередь аудио-чанков, отправка на Whisper API (Groq или OpenAI), трансляция результатов через IPC.

**Ключевые экспорты**:
- `initSttService(getWindowFn)` — инициализация
- `enqueueChunk(source, chunk, sampleRate, channels)` — добавить чанк в очередь
- `getAccumulatedTranscript(): string` — накопленный текст созвона (для LLM контекста)
- `getLastTranscriptTime(): number` — время последней транскрипции
- `clearTranscript(): void` — сброс
- `getQueueLength(): number` — длина очереди

**Внутренние функции**:
- `createWavBuffer(pcmData, sampleRate, channels): Buffer` — обёртка PCM в WAV-заголовок (44 байта)
- `transcribeChunk(wavBuffer, source): Promise<SttResult | null>` — multipart/form-data к Whisper
- `processQueue(): Promise<void>` — последовательная обработка (не параллельно!)
- `broadcastTranscription(payload): void` — отправка во все окна

**Константы**:
- `GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'`
- `OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'`
- `WHISPER_MODEL_GROQ = 'whisper-large-v3'`, `WHISPER_MODEL_OPENAI = 'whisper-1'`
- `MIN_CHUNK_SIZE_BYTES = 32000` (~1 сек)
- `language = 'ru'` (захардкожен)

**Известные баги**:
- `broadcastTranscription()` отправляет дубли: сначала через `getWindow()`, потом через `getAllWindows()`
- `fetch()` с Node.js `Buffer` body — может не работать, нужен `Uint8Array`

**Связи**: вызывается из handlers.ts, читает настройки из settings.ts

---

### `src/main/services/openrouterService.ts` — 293 строки, 11.6 KB

**Ответственность**: Streaming LLM через OpenRouter API. Генерация подсказок по 1С на основе накопленной транскрипции.

**Ключевые экспорты**:
- `initOpenRouterService(getWindowFn)` — инициализация
- `streamSuggestion(customTranscript?)` — основной стриминг-запрос к OpenRouter
- `abortStream()` — прерывание текущего стриминга (AbortController)
- `triggerAutoSuggestion()` — авто-отправка при паузе (2с таймер)
- `manualSuggestion()` — ручной запрос
- `isStreamingActive(): boolean` — состояние стриминга
- `clearSuggestionHistory(): void` — сброс истории

**Константы**:
- `OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'`
- `DEFAULT_MODEL = 'qwen/qwen-2.5-coder-32b-instruct'`
- `SYSTEM_PROMPT` — захардкоженный промпт: эксперт по 1С:Предприятие 8
- `MIN_SILENCE_BEFORE_LLM = 2000` (ms)
- `MIN_TRANSCRIPT_LENGTH = 20` (chars)
- `MAX_CONTEXT_CHARS = 12000`
- `temperature: 0.4`, `max_tokens: 1024`

**Внутреннее состояние**:
- `suggestionHistory: Array<{role: 'assistant'; content: string}>` — последние 3 подсказки
- `autoSendTimer` — таймер авто-отправки
- `streamAbortController` — для прерывания SSE

**Известные баги**:
- `suggestionHistory` хранит только `assistant` сообщения — нарушает формат OpenAI chat (нужны пары user/assistant)

**Связи**: вызывается из handlers.ts, читает транскрипцию из sttService, настройки из settings.ts

---

### `src/main/store/settings.ts` — 23 строки, 0.6 KB

**Ответственность**: Обёртка над electron-store для CRUD настроек приложения.

**Ключевые функции**:
- `getAllSettings()` — вернуть все настройки (merged с DEFAULT_SETTINGS)
- `saveSetting(key, value)` — сохранить одну настройку
- `getSetting(key)` — прочитать одну настройку

**Связи**: используется handlers.ts, sttService.ts, openrouterService.ts, overlayWindow.ts

---

### `src/main/windows/overlayWindow.ts` — 144 строки, 4.5 KB

**Ответственность**: Фабрика overlay-окон (toolbar, suggestion, transcript). Настройки прозрачности, alwaysOnTop, frameless, mouse passthrough.

**Ключевые экспорты**:
- `createOverlayWindow(kind: OverlayWindowKind, preloadPath, hash): BrowserWindow` — создать окно
- `applyOverlayMousePassthrough(win, ignore, forward)` — вкл/выкл сквозных кликов
- `moveWindowByDelta(win, dx, dy)` — перемещение окна на дельту

**Конфигурация окон**:

| Kind | Width | Height | MinWidth | MinHeight | Особенности |
|------|-------|--------|----------|-----------|-------------|
| toolbar | 360 | 64 | 200 | 60 | focusable, frameless, transparent, `show()` |
| suggestion | 420 | 320 | 280 | 120 | focusable: false, frame: true, backgroundColor: '#14141e', `showInactive()` |
| transcript | 380 | 420 | 280 | 160 | focusable: false, frame: true, backgroundColor: '#14141e', `showInactive()` |

**Важные нюансы**:
- Все окна: `alwaysOnTop: true`, `skipTaskbar: true`, `autoHideMenuBar: true`
- Toolbar: drag через `-webkit-app-region: drag` в CSS
- Suggestion/Transcript в debug-режиме: непрозрачные с тёмным фоном `#14141e` и рамкой для видимости
- Mouse passthrough: `setIgnoreMouseEvents(true, {forward: true})` + динамическое переключение по mouseenter/mouseleave в renderer
- macOS: `type: 'panel'`

**Связи**: вызывается из handlers.ts, читает overlayWidth и overlayOpacity из settings.ts

---

## Shared

### `src/shared/ipc.ts` — 101 строка, 3.0 KB

**Ответственность**: Общие константы IPC-каналов, типы настроек и payload'ов, DEFAULT_SETTINGS.

**Ключевые экспорты**:
- `IPC` — объект с именами всех каналов (5 групп: audio, transcription, suggestion, window, settings)
- `AppSettings` — тип настроек (openRouterApiKey, openRouterModel, sttApiKey, sttProvider, overlayOpacity, overlayWidth)
- `DEFAULT_SETTINGS` — дефолтные значения (модель: `qwen/qwen-2.5-coder-32b-instruct`, провайдер: `groq`, opacity: 0.85)
- `TranscriptionUpdatePayload` — `{text, speaker?, isFinal?, timestamp?}`
- `SuggestionUpdatePayload` — `{content, streaming?}`
- `AudioChunkPayload` — `{data: ArrayBuffer, sampleRate, channels}`
- `IgnoreMouseEventsOptions` — `{forward?}`

**Связи**: импортируется ВСЕМИ модулями (main, preload, renderer)

---

## Preload

### `src/preload/index.ts` — 142 строки, 6.2 KB

**Ответственность**: Preload-скрипт. Создаёт типобезопасный IPC-мост через `contextBridge.exposeInMainWorld('copilot', api)`.

**API-структура (5 namespaces)**:
- `copilot.settings` — `getAll()`, `save(key, value)`
- `copilot.window` — `setIgnoreMouseEvents`, `setTransparent`, `moveWindow`, `show`, `hide`, `toggleAllVisibility`
- `copilot.audio` — `startStreams`, `stopStreams`, `startNativeLoopback`, `stopNativeLoopback`, `enableLoopback`, `disableLoopback`, `onMicChunk`, `onSpeakerChunk`, `onLoopbackStarted/Stopped/Error`, `onMicCaptureStart`, `onMicCaptureStop`, `sendMicChunk`
- `copilot.transcription` — `openWindow`, `closeWindow`, `isWindowOpen`, `pushUpdate`, `clear`, `onUpdate`, `onClear`, `getCurrent`
- `copilot.suggestion` — `openWindow`, `show`, `hideAll`, `toggleVisibility`, `setOpacity`, `setWidth`, `setHeight`, `updateContent`, `onContentUpdate`, `request`, `abort`, `isStreaming`

**Вспомогательная функция**: `subscribe<T>(channel, cb): () => void` — обёртка над `ipcRenderer.on` с отпиской

**Связи**: использует IPC-каналы из @shared/ipc

---

## Renderer (React)

### `src/renderer/src/App.tsx` — 62 строки, 2.0 KB

**Ответственность**: Hash-based роутер + координация записи. Определяет маршрут по `window.location.hash` и рендерит соответствующий компонент.

**Ключевые элементы**:
- `getRouteFromHash()` — парсинг хеша: `#/toolbar`, `#/suggestion`, `#/transcript`
- `toggleRecording()` — старт/стоп аудио-захвата (mic + system)
- `useMicCapture()` hook инициализируется на top level

**Связи**: рендерит Toolbar, SuggestionPanel, TranscriptPanel, SettingsPanel

---

### `src/renderer/src/hooks/useMicCapture.ts` — 142 строки, 4.8 KB

**Ответственность**: Захват микрофона через getUserMedia в Renderer-процессе. Это ключевая реализация решения о переносе захвата микрофона из Main (ffmpeg dshow) в Renderer (Chromium AudioContext).

**Ключевые элементы**:
- `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}})`
- `AudioContext({sampleRate: 16000})` — целевой формат 16kHz
- `ScriptProcessorNode(4096)` — буфер 4096 сэмплов
- Float32→Int16 PCM конверсия: `Math.max(-32768, Math.min(32767, Math.round(sample * 32767))))`
- `window.copilot.audio.sendMicChunk(Int16Array.buffer)` — отправка через IPC
- Активация/деактивация по IPC-сигналам `audio:micCaptureStart` / `audio:micCaptureStop`
- Возвращает `{startCapture, stopCapture, isActive}`

**Почему ScriptProcessorNode, а не AudioWorklet**: ScriptProcessorNode проще в реализации и работает стабильнее в текущей версии Electron. AudioWorklet — более современный API, но требует отдельного worklet-файла и сложнее в отладке. Миграция запланирована.

---

### `src/renderer/src/components/Toolbar.tsx` — 79 строк, 2.5 KB

**Ответственность**: Тулбар — кнопки управления (Слушать/Стоп, Подсказки, Текст, Настройки).

**Ключевые элементы**:
- Drag через `onMouseDown` + `window.copilot.window.moveWindow(dx, dy)`
- Кнопка «▶ Слушать» / «● Стоп» с зелёной точкой-индикатором записи
- «Подсказки» → `window.copilot.suggestion.toggleVisibility()`
- «Текст» → `window.copilot.transcription.openWindow()`
- «⚙» → SettingsPanel
- `-webkit-app-region: drag` для перетаскивания окна

---

### `src/renderer/src/components/SuggestionPanel.tsx` — 138 строк, 4.0 KB

**Ответственность**: Панель подсказок 1С. Подписка на `suggestion:update-content`, кнопки «Спросить ИИ» / «Стоп».

**Ключевые элементы**:
- Подписка на `window.copilot.suggestion.onContentUpdate` — обновление контента
- `streaming` флаг — бейдж «stream» и кнопка «Стоп» / «Спросить ИИ»
- Mono-шрифт для отображения (plain text, без Markdown-рендеринга)
- DOM-based динамический mouse passthrough (mouseenter → clickable, mouseleave → click-through)

**Известный баг**: отсутствует `import { useState, useEffect } from 'react'` — TS2304 ошибка компиляции

---

### `src/renderer/src/components/TranscriptPanel.tsx` — 118 строк, 3.5 KB

**Ответственность**: Панель расшифровки. Список строк с speaker-метками (mic / system / unknown).

**Ключевые элементы**:
- Подписка на `window.copilot.transcription.onUpdate` — добавление строк
- Подписка на `window.copilot.transcription.onClear` — очистка
- Ограничение: хранятся последние 200 строк (`slice(-200)`)
- Кнопка «Очистить» → `window.copilot.transcription.clear()`
- DOM-based динамический mouse passthrough

**Известный баг**: отсутствует `import { useState, useEffect } from 'react'` — TS2304 ошибка компиляции

---

### `src/renderer/src/components/SettingsPanel.tsx` — 183 строки, 5.5 KB

**Ответственность**: Панель настроек. API ключи, провайдер STT, модель LLM, прозрачность и ширина оверлея.

**Ключевые элементы**:
- Загрузка настроек через `window.copilot.settings.getAll()`
- Пошаговое сохранение через `window.copilot.settings.save(key, value)`
- 3 секции: OpenRouter (LLM), STT (Whisper), Overlay (opacity, width)
- Применение opacity и width через `window.copilot.suggestion.setOpacity/setWidth`

---

### `src/renderer/src/styles/theme.css` — 52 строки, 1.5 KB

**Ответственность**: CSS-переменные. Material Dark палитра (`#121212` base, `#bb86fc` primary, `#03dac6` secondary), glass-morphism, spacing, typography.

---

### `src/renderer/src/styles/global.css` — 95 строк, 1.9 KB

**Ответственность**: Глобальные стили. Reset, glass-panel, glass-card, кнопки (btn-primary, btn-ghost), scroll-y, mono.

---

## Конфигурация

### `electron.vite.config.ts` — 27 строк, 0.6 KB

**Ответственность**: Конфигурация electron-vite. Алиасы `@shared` → `src/shared`, `@renderer` → `src/renderer/src`. ExternalizeDeps для main и preload. `win-audio-capture` в external для rollup.

### `package.json` — 30 строк, 0.8 KB

**Ответственность**: Зависимости и скрипты. NPM-скрипты: `dev`, `build`, `preview`, `typecheck`. Версия `0.1.0` в package.json (фактическая документированная версия — V1.0.0).
