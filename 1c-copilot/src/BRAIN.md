# 1C-Copilot — Memory Bank (V1.2.0, обновлено 2026-06-13)

---

## 1. Обзор проекта

**1C-Copilot** — десктопное overlay-приложение для Windows, которое слушает аудио созвона (микрофон + системный звук), транскрибирует речь в реальном времени через Whisper API и генерирует краткие технические подсказки по 1С:Предприятие 8 через OpenRouter LLM со стримингом. Подсказки отображаются в полупрозрачном overlay поверх всех окон.

**Задача**: помочь 1С-разработчику на технических интервью и созвонах — AI-ассистент анализирует живую речь и выдаёт подсказки в реальном времени.

### Стек

| Слой | Технология | Версия |
|------|-----------|--------|
| Desktop runtime | Electron | 31.7.7 |
| UI | React | 18.3.1 |
| Язык | TypeScript | 5.7.2 |
| Сборка | electron-vite | 2.3.0 |
| Микрофон (Renderer) | Web Audio API | getUserMedia + AudioContext + ScriptProcessorNode |
| Системный звук (Windows) | win-audio-capture | 1.0.1 (WASAPI Loopback) |
| Системный звук (fallback) | ffmpeg | dshow / avfoundation / alsa |
| STT | Groq / OpenAI Whisper API | whisper-large-v3 / whisper-1 |
| LLM | OpenRouter API | google/gemini-2.0-flash-001 |
| Прокси | undici ProxyAgent | Node.js native fetch через HTTP прокси |

### Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│  RENDERER-ПРОЦЕСС (Chromium)                                       │
│  getUserMedia → AudioContext(16kHz) → ScriptProcessorNode           │
│  → Float32→Int16 PCM → window.copilot.audio.sendMicChunk(IPC)     │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────┐                │
│  │ Toolbar │  │ Suggestion   │  │ Transcript     │                │
│  │ 360×64  │  │ Panel 420×320│  │ Panel 380×420  │                │
│  └─────────┘  └──────────────┘  └────────────────┘                │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ IPC (contextBridge)
┌──────────────────────────▼─────────────────────────────────────────┐
│  MAIN-ПРОЦЕСС (Node.js)                                           │
│  handleMicChunkFromRenderer → ChunkBuffer('mic') ──┐              │
│  WASAPI Loopback → ChunkBuffer('system') ──────────┤              │
│                                        chunkCallback()            │
│                                        → enqueueChunk()           │
│                                        → sttService (Whisper API) │
│                                        → openrouterService (SSE)  │
│  Прокси: undici ProxyAgent → Node.js fetch (НЕ Chromium net.fetch)│
└───────────────────────────────────────────────────────────────────┘
```

### Поток данных

1. Пользователь нажимает «Слушать» → IPC `audio:startStreams` + `audio:startNativeLoopback`
2. Renderer: getUserMedia → AudioContext(16kHz) → PCM Int16 → IPC `audio:sendMicChunk`
3. Main: `handleMicChunkFromRenderer()` → `ChunkBuffer('mic')`
4. Main: WASAPI/ffmpeg → `ChunkBuffer('system')`
5. ChunkBuffer'ы накапливают 6с (192 000 байт) → `chunkCallback` → `enqueueChunk()`
6. sttService: Silence Gate → PCM → WAV (44 байта заголовок) → multipart/form-data → Groq/OpenAI Whisper
7. Результат → `transcription:update` IPC → TranscriptPanel
8. При паузе 2с → `triggerAutoSuggestion()` → OpenRouter SSE → `suggestion:update-content` → SuggestionPanel

---

## 2. Сравнительный анализ с ShadowHint (референсный проект)

### Источник: native.7z → app.asar (ShadowHint v0.1.134)

**ShadowHint** — коммерческий аналог (https://shadowhint.com), та же задача: AI-ассистент на интервью. Извлечён из `app.asar`, webpack-bundled.

### Фундаментальная разница архитектур

| Аспект | ShadowHint | 1C-Copilot (наш) |
|--------|-----------|-------------------|
| **STT/LLM бэкенд** | gRPC сервер `api.shadowhint.com:9000` — вся обработка на сервере | Прямые HTTP-запросы к Groq/OpenRouter из Main-процесса |
| **Аудио-протокол** | gRPC bidirectional streaming (`StreamAudio`) — чанки летят потоком, сервер сам решает когда транскрибировать | HTTP multipart POST каждого 6с чанка по очереди |
| **STT провайдер** | Deepgram (основной) + Groq (фолбэк) — выбор через `sttProvider` настройку | Только Groq/OpenAI Whisper |
| **VAD (Voice Activity Detection)** | Серверный (`vadMode`, `maxSpeechSeconds` — настройки) | Клиентский Silence Gate (порог амплитуды < 400) |
| **Системный звук** | 3 метода: `electron-audio-loopback` (macOS/Linux), `process-loopback` (Win native addon, исключает свой процесс!), `naudiodon` (фолбэк) | `win-audio-capture` (WASAPI) + ffmpeg fallback |
| **Аудио-сжатие** | Opus (через `opusscript`) для Deepgram; PCM только для Groq | Только PCM (16kHz mono 16-bit) |
| **Аутентификация** | OAuth2 через сервер (email + код, browser auth) | API-ключи в настройках (electron-store) |
| **Сборка** | electron-forge + webpack | electron-vite |
| **Логирование** | Winston → Loki | console.log |
| **Мониторинг** | Sentry (ошибки + профилирование) | Нет |
| **Маскировка** | Disguise (замена иконки/названия: Chrome, Edge, Defender и т.д.) | Нет |
| **Обновления** | electron-updater (GitHub Releases) | Нет |
| **Скриншоты** | screenshot-desktop + screen capture для мультимодальности | Нет |
| **Модели LLM** | Выбор модели через UI (preferredModel) | Одна модель в настройках |

### Что ShadowHint делает ПРАВИЛЬНО — и что нам перенять

#### 1. 🔴 `process-loopback` вместо `win-audio-capture`

**Проблема**: `win-audio-capture` захватывает ВСЕ системные звуки, включая звук самого приложения (эхо). Если LLM генерирует речь (TTS) или приложение воспроизводит звук — он попадает в транскрипцию.

**Решение ShadowHint**: Нативный C++ addon `process-loopback` с параметром `excludeProcessId: process.pid` — исключает аудио собственного процесса из захвата. Это критически важно для предотвращения эха.

**Что делать**: Заменить `win-audio-capture` на `process-loopback` (исходник есть в `native.7z`) или добавить параметр исключения процесса.

#### 2. 🔴 `electron-audio-loopback` для macOS/Linux

**Проблема**: Наш ffmpeg fallback ненадёжен — кириллица в именах устройств, zombie-процессы.

**Решение ShadowHint**: `electron-audio-loopback` — использует Chromium `desktopCapturer` + `getDisplayMedia` для системного звука. Работает через `session.setDisplayMediaRequestHandler()` и фича-флаги Chromium:
- `PulseaudioLoopbackForScreenShare` (Linux)
- `MacSckSystemAudioLoopbackOverride` (macOS)
- Для Windows — нативный `process-loopback`

**Что делать**: Добавить `electron-audio-loopback` для кроссплатформенного loopback.

#### 3. 🔴 Серверная VAD вместо клиентского Silence Gate

**Проблема**: Наш Silence Gate (амплитуда < 400) — грубый эвристика. Он может:
- Пропустить тихую речь (шёпот)
- Отсечь начало/конец фразы
- Не распознать шум вентилятора как тишину

**Решение ShadowHint**: VAD на сервере (`vadMode` + `maxSpeechSeconds`) — сервер получает весь аудиопоток и сам определяет границы речи через более продвинутые алгоритмы.

**Что делать**: Пока нет сервера — улучшить клиентский Silence Gate:
- Добавить RMS (root mean square) вместо простого maxAmplitude
- Добавить минимальную длительность тишины перед отсечкой (не сразу, а после N кадров)
- Рассмотреть WebRTC VAD или Silero VAD

#### 4. 🟡 Opus-сжатие для аудио

**Проблема**: 6с PCM = 192KB на чанк. При 2 потоках × 10 чанков/мин = ~3.8 МБ/мин трафика через прокси.

**Решение ShadowHint**: Opus-кодирование через `opusscript` для Deepgram (который принимает Opus). Сжатие ~10x.

**Что делать**: Если перейдём на Deepgram — добавить Opus. Для Groq Whisper — остаётся PCM/WAV (Groq не принимает Opus).

#### 5. 🟡 gRPC стриминг вместо HTTP polling

**Проблема**: Каждый чанк — отдельный HTTP-запрос (multipart). Rate limits, задержки, overhead на соединение.

**Решение ShadowHint**: gRPC bidirectional stream — одно соединение, чанки летят потоком, сервер стримит транскрипции обратно. Никаких rate limits на стороне клиента.

**Что делать**: Долгосрочно — рассмотреть gRPC-бэкенд. Краткосрочно — текущий подход работает, но ограничен rate limits.

#### 6. 🟡 Маскировка (Disguise)

**Проблема**: Окно "1C-Copilot" видно в панели задач — собеседник может заметить.

**Решение ShadowHint**: Система маскировки — замена иконки и названия на "Google Chrome", "Microsoft Edge", "Windows Defender" и т.д. Папка `disguise/` содержит .ico файлы.

**Что делать**: Добавить в настройки выбор маскировки.

#### 7. 🟡 Sentry + Winston логирование

**Проблема**: Все ошибки только в console.log — на Windows-машине разработчика не видно что происходит.

**Решение ShadowHint**: Sentry для отслеживания ошибок + Winston для структурированного логирования + Loki для агрегации.

**Что делать**: Добавить хотя бы Winston для логирования в файл.

### Что ShadowHint делает ХУЖЕ — наши преимущества

1. **Простота**: Наш проект — 7 файлов в Main. ShadowHint — 3.5MB минифицированного webpack-бандла. Мы можем изменять код за минуты.
2. **Автономность**: Работает без сервера. ShadowHint мёртв без `api.shadowhint.com:9000`.
3. **Прокси**: undici ProxyAgent — проверенное решение для прокси-авторизации. ShadowHint, судя по коду, не работает через корпоративные прокси.
4. **Silence Gate**: У нас уже есть! У ShadowHint VAD серверный, но в клиенте нет защиты от отправки тишины.

---

## 3. Ловушки внешних API

**ГЛАВНАЯ ЛОВУШКА**: Whisper API не принимает raw PCM — обязательно оборачивать в WAV через `createWavBuffer()`.

### Groq Whisper API
- `POST https://api.groq.com/openai/v1/audio/transcriptions`
- Ключ `gsk_...`, модель `whisper-large-v3`, language `ru`
- Rate limit: 30 запросов/мин (два потока = 20/мин — впритык)
- Min chunk: 32000 байт (~1 сек), max: 25 МБ
- Multipart вручную через Buffer.concat (НЕ npm form-data)

### OpenAI Whisper API
- `POST https://api.openai.com/v1/audio/transcriptions`
- Ключ `sk_...`, модель `whisper-1`, платный ($0.006/мин)

### OpenRouter API
- `POST https://openrouter.ai/api/v1/chat/completions`
- Ключ `sk-or-v1-...`, заголовки `HTTP-Referer` + `X-Title` обязательны
- `stream: true` → SSE, `data: [DONE]` — конец, `delta.content` — токены
- SSE режет JSON — буферизация: `buffer = lines.pop()`
- **БАГ**: suggestionHistory только assistant — нарушает формат chat

### getUserMedia (Renderer)
- `AudioContext({sampleRate: 16000})` — обычно поддерживается, но может не ровно 16kHz
- ScriptProcessorNode deprecated → миграция на AudioWorklet запланирована
- Первый вызов показывает диалог разрешения
- IPC serialization: ~8KB на чанк (4096 float32 сэмплов)

### Прокси (undici)
- **НЕ используем Chromium net.fetch** — баг Electron #44249: `net.fetch` не триггерит `session.on('login')` для прокси-авторизации
- Прогрев через BrowserWindow тоже НЕ помог — туннель падает до этапа авторизации
- **Решение**: `undici.ProxyAgent` + `setGlobalDispatcher` → Node.js native `fetch` идёт через прокси
- Credentials встроены в URL: `http://user:pass@host:port`
- НЕ нужно `session.setProxy`, НЕ нужен `session.on('login')`, НЕ нужен warmup BrowserWindow

---

## 4. Модули проекта

### Main-процесс

| Файл | Строки | Роль |
|------|--------|------|
| `index.ts` | 67 | Точка входа. Single-instance lock, undici ProxyAgent, cleanup на before-quit |
| `ipc/handlers.ts` | 378 | 30+ IPC обработчиков. Пайплайн audio→STT→LLM |
| `services/audioCapture.ts` | 552 | Mic: IPC от Renderer. System: WASAPI/ffmpeg. ChunkBuffer 6с |
| `services/sttService.ts` | 369 | Очередь → Silence Gate → Whisper API. Rate limit + retry |
| `services/openrouterService.ts` | 298 | SSE streaming. Модель: gemini-2.0-flash-001 |
| `services/proxyFetch.ts` | 137 | undici ProxyAgent + fallback на direct |
| `store/settings.ts` | 23 | electron-store CRUD |
| `windows/overlayWindow.ts` | 144 | Фабрика 3 окон. Debug: непрозрачные #14141e |

### Shared/Preload

| Файл | Роль |
|------|------|
| `shared/ipc.ts` | 30+ IPC каналов, типы, DEFAULT_SETTINGS |
| `preload/index.ts` | contextBridge → `window.copilot.*` (5 namespace) |

### Renderer

| Файл | Роль |
|------|------|
| `App.tsx` | Hash-роутер + useMicCapture |
| `hooks/useMicCapture.ts` | getUserMedia → AudioContext(16kHz) → PCM Int16 → IPC |
| `Toolbar.tsx` | Кнопки: Слушать/Стоп, Подсказки, Текст, Настройки |
| `SuggestionPanel.tsx` | Подсказки. БАГ: нет import useState |
| `TranscriptPanel.tsx` | Расшифровка. Кликабельное, resizable |
| `SettingsPanel.tsx` | API ключи, провайдер, модель, opacity/width |

---

## 5. Текущее состояние

**V1.2.0** — Проект собирается (`electron-vite build` OK). Аудио-пайплайн реорганизован: микрофон через getUserMedia в Renderer, системный звук через WASAPI в Main. Прокси переведён на `undici ProxyAgent` (вместо сломанного Chromium `net.fetch`). Silence Gate добавлен в sttService. Модель LLM изменена на Gemini Flash 2.0. Рантайм тестируется на Windows.

### Что РАБОТАЕТ
- ✅ Прокси через undici ProxyAgent (подтверждено: HTTP 401 от api.groq.com)
- ✅ Silence Gate в sttService (амплитуда < 400 → skip)
- ✅ Rate limit: 3с пауза + retry при 429
- ✅ SSE стриминг через fetchWithFallback (НЕ net.fetch)
- ✅ Транскрипция: микрофон → ChunkBuffer → Whisper → TranscriptPanel
- ✅ Подсказки: пауза 2с → OpenRouter SSE → SuggestionPanel
- ✅ TranscriptPanel кликабельный и resizable
- ✅ Убран «Продолжение следует» (пустой broadcastSuggestion убран)

### Что НЕ РАБОТАЕТ / НУЖНО
- ❌ `win-audio-capture` не исключает собственный процесс (эхо)
- ❌ suggestionHistory без user-пар — нарушает формат chat
- ❌ 5 ошибок TS (useState imports, React import)
- ❌ Нет маскировки (Disguise)
- ❌ Нет логирования в файл (Winston)

---

## 6. Известные проблемы и техдолг

### Критические
1. **5 ошибок TS** — нет import useState в панелях, кривой import React
2. **Эхо системного звука** — win-audio-capture не исключает собственный процесс; нужен process-loopback
3. **suggestionHistory без user-пар** — нарушает формат chat API

### Модульные
- **audioCapture**: WASAPI sampleRate 44100 захардкожен, нет VAD (только Silence Gate в sttService)
- **openrouterService**: suggestionHistory — только assistant-сообщения
- **handlers**: 4 хардкод-строки IPC вместо констант
- **Renderer**: нет Markdown-рендеринга, SettingsPanel пошаговое сохранение

### Техдолг
Нет тестов, нет логирования в файл, нет electron-builder, inline CSS, нет TypeScript strict, два package.json (src/ и pkg/), нет .env, ScriptProcessorNode deprecated, нет маскировки (Disguise), нет скриншотов для мультимодальности

---

## 7. Что НЕ сработало

1. **ffmpeg dshow микрофон** — кириллица в именах устройств → кракозябры, dummy-устройства нестабильны, ложный spawn status. Решение: getUserMedia в Renderer.
2. **Рекурсивный ffmpeg fallback** — CaptureCandidate + tryNextDevice() логически корректен, но фундаментальная проблема кодировки остаётся. Решение: полная миграция на getUserMedia.
3. **Web Audio API для системного звука** — браузер не даёт loopback. Решение: WASAPI в Main.
4. **Raw PCM на Whisper API** — HTTP 400. Решение: createWavBuffer().
5. **npm form-data** — ломает externalizeDepsPlugin. Решение: ручной Buffer.concat.
6. **Параллельная STT-отправка** — rate limit исчерпан. Решение: последовательная очередь.
7. **Stereo Mix** — отключён по умолчанию на большинстве машин. Решение: WASAPI loopback.
8. **app.commandLine.appendSwitch('proxy-server')** — ERR_TUNNEL_CONNECTION_FAILED, ломает HTTPS. Решение: session.setProxy без http:// префикса.
9. **session.on('login') без webContents** — сдвиг параметров, authInfo.isProxy всегда false. Решение: правильная 5-аргументная сигнатура.
10. **net.fetch + session.on('login')** (Electron #44249) — net.fetch НЕ триггерит login-событие, даже с правильной сигнатурой. Решение: undici ProxyAgent.
11. **Proxy warmup через BrowserWindow** — прогрев не помог, потому что Chromium туннель падает ДО этапа авторизации (ERR_TUNNEL_CONNECTION_FAILED), login-событие никогда не вызывается. Решение: undici ProxyAgent.
12. **globalThis.fetch = net.fetch** — ломал SSE-стриминг: ReadableStream.getReader() не работал с net.fetch response body. Решение: использовать стандартный Node.js fetch через undici ProxyAgent.

---

## 8. Решения и обоснования

1. **getUserMedia вместо ffmpeg dshow** — изоляция от кодировок Windows, стабильный stream, стандартный API
2. **WASAPI в try/catch** — graceful degradation: нет системного звука → работаем с микрофоном
3. **Electron вместо web** — нужен overlay + системный звук
4. **3 отдельных окна** — независимая видимость/позиция/прозрачность
5. **Hash-based роутинг** — один bundle, простая сборка
6. **6-секундные чанки** — баланс качества Whisper и задержки
7. **Ручной multipart** — без зависимостей, полный контроль
8. **Последовательная STT-очередь** — rate limit + порядок результатов
9. **undici ProxyAgent вместо Chromium proxy** — net.fetch не поддерживает прокси-авторизацию (Electron #44249), Node.js fetch через ProxyAgent работает надёжно
10. **Silence Gate (амплитуда < 400)** — предотвращает галлюцинации Whisper («Продолжение следует...»), экономит rate limit Groq
11. **fetchWithFallback** — автоматический fallback с прокси на direct при ошибках туннеля
12. **Gemini Flash 2.0 вместо Qwen Coder** — быстрее, умнее, дешевле
13. **Debug overlay (#14141e)** — видимые окна для отладки на Windows-машине

---

## 9. Как писать код

### Аудио-формат — СВЯТОЕ
```
PCM 16000 Hz, 1 канал (моно), 16-bit (s16le)
Чанк: 6 секунд = 192 000 байт
```

### Overlay-окна — НЕ ЛОМАТЬ ТЮНИНГ
- `backgroundColor: '#02000000'` (НЕ `#00000000` — клики перестанут работать)
- `setIgnoreMouseEvents(true, {forward: true})` + динамическое переключение mouseenter/mouseleave
- `showInactive()` для suggestion/transcript (НЕ `show()` — украдёт фокус)
- Управление прозрачностью только через IPC

### IPC-мост
- Единственный способ main↔renderer: `ipcMain.handle` / `webContents.send`
- Renderer вызывает `window.copilot.*` — НЕ `ipcRenderer.*` напрямую
- Новый канал → ipc.ts (имя + тип) → preload (метод + CopilotApi) → handlers

### Принципы
1. Простота > зависимости
2. Fallback всегда (WASAPI→ffmpeg, Groq→OpenAI, network error→лог)
3. Последовательность > параллельность (STT очередь)
4. PCM 16kHz mono 16-bit — единый формат
5. НЕ трогать globalThis.fetch — только undici ProxyAgent через setGlobalDispatcher

### Критические уроки
1. НЕ отправляй raw PCM на Whisper — только WAV
2. НЕ отправляй STT чанки параллельно — rate limit
3. НЕ используй Web Audio для системного звука — только нативные модули
4. НЕ используй ffmpeg dshow для микрофона — кириллица ломает кодировку
5. НЕ забывай `language: "ru"` для Whisper
6. НЕ парси SSE без буферизации — `buffer = lines.pop()`
7. НЕ ставь captureState=true до проверки что процесс жив
8. НЕ используй `net.fetch` для прокси — баг Electron #44249 (не триггерит login)
9. НЕ полагайся на session.on('login') + warmup — используй undici ProxyAgent
10. НЕ ставь `http://` в proxyRules — ломает HTTPS туннель (для Chromium proxy)
11. НЕ переопределяй globalThis.fetch = net.fetch — ломает SSE ReadableStream
12. НЕ отправляй пустые broadcastSuggestion — вызывает «Продолжение следует»
13. НЕ отправляй тишину на Whisper — Silence Gate (амплитуда < 400) перед WAV-конвертацией

---

## 10. Следующие шаги

### Приоритет 0 🔴 — Критические баги
- [ ] Добавить `import { useState, useEffect } from 'react'` в SuggestionPanel.tsx и TranscriptPanel.tsx
- [ ] Заменить `import React from 'react'` на `import * as React from 'react'` в main.tsx
- [ ] Исправить suggestionHistory: пары user/assistant вместо только assistant

### Приоритет 1 🔴 — Системный звук без эха
- [ ] Заменить `win-audio-capture` на `process-loopback` (исходник из native.7z)
  - `excludeProcessId: process.pid` — исключает собственный процесс
  - Прямой WASAPI loopback без зависимости от устройства
- [ ] Альтернатива: добавить `electron-audio-loopback` для macOS/Linux
  - Использует Chromium `desktopCapturer` + `setDisplayMediaRequestHandler()`
  - Фича-флаги: `PulseaudioLoopbackForScreenShare`, `MacSckSystemAudioLoopbackOverride`

### Приоритет 2 🟡 — Улучшение Silence Gate
- [ ] RMS (Root Mean Square) вместо простого maxAmplitude
- [ ] Минимальная длительность тишины (N кадров подряд < порога) перед отсечкой
- [ ] Рассмотреть Silero VAD или WebRTC VAD для более точного определения речи

### Приоритет 3 🟡 — Маскировка (Disguise)
- [ ] Замена иконки и названия окна (Chrome, Edge, Defender и т.д.)
- [ ] Папка `disguise/` с .ico файлами (взять из ShadowHint)
- [ ] Выбор маскировки в настройках

### Приоритет 4 🟡 — Логирование
- [ ] Winston для структурированного логирования в файл
- [ ] Опционально: Sentry для отслеживания ошибок

### Приоритет 5 🟡 — Overlay
- [ ] Переключатель debug/production режима
- [ ] Production: transparent, #02000000, focusable: false, frame: false
- [ ] Markdown-рендеринг в SuggestionPanel (react-markdown + remark-gfm)

### Приоритет 6+ 🟢
- [ ] Скриншоты для мультимодальности (screenshot-desktop)
- [ ] Горячие клавиши, системный трей
- [ ] electron-builder для упаковки
- [ ] Тесты (vitest)
- [ ] AudioWorklet вместо ScriptProcessorNode
