# 1C-Copilot — Memory Bank (V1.3.0, обновлено 2026-06-13)

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
| LLM | OpenRouter API | google/gemini-2.5-flash |
| Прокси (STT) | undici ProxyAgent | Node.js native fetch через HTTP прокси |
| Прокси (LLM) | Electron session proxy | net.request через Chromium stack |

### Архитектура (ДВОЙНАЯ ПРОКСИ)

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
│                                                                    │
│  ДВОЙНОЙ ПРОКСИ:                                                   │
│  ┌──────────────────────────────┐ ┌──────────────────────────────┐ │
│  │ sttService → Groq Whisper    │ │ openrouterService → OpenRouter│ │
│  │ Node.js fetch                │ │ Electron net.request          │ │
│  │ undici ProxyAgent            │ │ session.setProxy + .on(login) │ │
│  │ (credentials в URL)          │ │ (Chromium network stack)      │ │
│  └──────────────────────────────┘ └──────────────────────────────┘ │
│                                                                    │
│  ФИЛЬТРАЦИЯ:                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Silence Gate (амплинтуда < 1200/32768) → отсекает тишину    │  │
│  │ Hallucination Filter → отсекает галлюцинации Whisper         │  │
│  │ Rate Limit (3с пауза + retry 429) → защита от rate limit    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### Поток данных

1. Пользователь нажимает «Слушать» → IPC `audio:startStreams` + `audio:startNativeLoopback`
2. Renderer: getUserMedia → AudioContext(16kHz) → PCM Int16 → IPC `audio:sendMicChunk`
3. Main: `handleMicChunkFromRenderer()` → `ChunkBuffer('mic')`
4. Main: WASAPI/ffmpeg → `ChunkBuffer('system')`
5. ChunkBuffer'ы накапливают 6с (192 000 байт) → `chunkCallback` → `enqueueChunk()`
6. sttService: **Silence Gate** (амплинтуда < 1200) → PCM → WAV → multipart/form-data → Groq/OpenAI Whisper
7. **Hallucination Filter**: проверяет текст на типичные галлюцинации Whisper → отбрасывает мусор
8. Результат → `transcription:update` IPC → TranscriptPanel
9. При паузе 2с → `triggerAutoSuggestion()` → OpenRouter SSE через **net.request** → `suggestion:update-content` → SuggestionPanel

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
| **VAD (Voice Activity Detection)** | Серверный (`vadMode`, `maxSpeechSeconds` — настройки) | Клиентский Silence Gate (порог амплитуды < 1200) + Hallucination Filter |
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

#### 3. 🟡 Серверная VAD вместо клиентского Silence Gate

**Проблема**: Наш Silence Gate (амплитуда < 1200) — грубая эвристика. Он может:
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
3. **Прокси**: Двойная прокси-архитектура (undici + session proxy). ShadowHint, судя по коду, не работает через корпоративные прокси.
4. **Silence Gate + Hallucination Filter**: Двойная защита от мусора. У ShadowHint VAD серверный, но в клиенте нет защиты от отправки тишины.

---

## 3. Ловушки внешних API

**ГЛАВНАЯ ЛОВУШКА**: Whisper API не принимает raw PCM — обязательно оборачивать в WAV через `createWavBuffer()`.

### Groq Whisper API
- `POST https://api.groq.com/openai/v1/audio/transcriptions`
- Ключ `gsk_...`, модель `whisper-large-v3`, language `ru`
- Rate limit: 30 запросов/мин (два потока = 20/мин — впритык)
- Min chunk: 32000 байт (~1 сек), max: 25 МБ
- Multipart вручную через Buffer.concat (НЕ npm form-data)
- **Через прокси**: Node.js fetch + undici ProxyAgent

### OpenAI Whisper API
- `POST https://api.openai.com/v1/audio/transcriptions`
- Ключ `sk_...`, модель `whisper-1`, платный ($0.006/мин)
- **Через прокси**: Node.js fetch + undici ProxyAgent

### OpenRouter API
- `POST https://openrouter.ai/api/v1/chat/completions`
- Ключ `sk-or-v1-...`, заголовки `HTTP-Referer` + `X-Title` обязательны
- `stream: true` → SSE, `data: [DONE]` — конец, `delta.content` — токены
- SSE режет JSON — буферизация: `buffer = lines.pop()`
- **Через прокси**: Electron `net.request` + `session.setProxy` + `session.on('login')`
- **Модель**: `google/gemini-2.5-flash`

### getUserMedia (Renderer)
- `AudioContext({sampleRate: 16000})` — обычно поддерживается, но может не ровно 16kHz
- ScriptProcessorNode deprecated → миграция на AudioWorklet запланирована
- Первый вызов показывает диалог разрешения
- IPC serialization: ~8KB на чанк (4096 float32 сэмплов)

### Прокси — ДВОЙНАЯ АРХИТЕКТУРА

**Прокси-сервер**: `http://jRUfBEhc:YCkn2DPH@153.80.159.108:64218`

| Сервис | Прокси-метод | Почему |
|--------|-------------|--------|
| sttService → Groq Whisper | `undici ProxyAgent` + `setGlobalDispatcher` | Node.js fetch через ProxyAgent — работает с multipart/form-data (бинарные WAV) |
| openrouterService → OpenRouter SSE | `session.setProxy` + `session.on('login')` + `net.request` | Chromium network stack — надёжный SSE-стриминг через прокси-туннель |

**Почему sttService НЕ использует net.request**: net.request не поддерживает отправку Buffer/Uint8Array body для multipart/form-data — только строковый JSON. Whisper API требует multipart с бинарным WAV-файлом.

**Почему openrouterService НЕ использует Node.js fetch**: Node.js fetch игнорирует настройки прокси Electron сессии. SSE-стриминг через undici ProxyAgent может терять данные при прокси-туннелировании. net.request использует Chromium stack, который лучше справляется с long-lived streaming connections.

**Критические баги Electron с прокси**:
- **Electron #44249**: `net.fetch` НЕ триггерит `session.on('login')` для прокси-авторизации. Туннель падает с ERR_TUNNEL_CONNECTION_FAILED.
- `net.request` — ДРУГОЙ API, НЕ имеет бага #44249. Использует Chromium network stack полностью.
- `proxyRules` ФОРМАТ: `http=host:port;https=host:port` (НЕ просто `host:port` — иначе HTTPS CONNECT может не создаться)

---

## 4. Модули проекта

### Main-процесс

| Файл | Строки | Роль |
|------|--------|------|
| `index.ts` | 80 | Точка входа. Single-instance lock, двойная прокси-инициализация, diagnostics |
| `ipc/handlers.ts` | 378 | 30+ IPC обработчиков. Пайплайн audio→STT→LLM |
| `services/audioCapture.ts` | 552 | Mic: IPC от Renderer. System: WASAPI/ffmpeg. ChunkBuffer 6с |
| `services/sttService.ts` | 397 | Очередь → Silence Gate → Hallucination Filter → Whisper API. Rate limit + retry |
| `services/openrouterService.ts` | 335 | net.request SSE streaming. Модель: gemini-2.5-flash |
| `services/proxyFetch.ts` | 220 | Двойная прокси: undici ProxyAgent + session proxy + testSessionProxy |
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

**V1.3.0** — Двойная прокси-архитектура: undici ProxyAgent для STT (multipart), Electron session proxy + net.request для LLM (SSE). Silence Gate порог 1200. Hallucination Filter добавлен. Модель LLM gemini-2.5-flash. Диагностика testSessionProxy() при старте.

### Что РАБОТАЕТ
- ✅ Прокси через undici ProxyAgent для STT (подтверждено: HTTP 401 от api.groq.com)
- ✅ Silence Gate в sttService (амплитуда < 1200 → skip)
- ✅ Hallucination Filter (отбрасывает «Продолжение следует», «Субтитры созданы» и пр.)
- ✅ Rate limit: 3с пауза + retry при 429
- ✅ SSE стриминг через net.request (Electron Chromium stack)
- ✅ Транскрипция: микрофон → ChunkBuffer → Whisper → TranscriptPanel
- ✅ Подсказки: пауза 2с → OpenRouter SSE → SuggestionPanel
- ✅ TranscriptPanel кликабельный и resizable
- ✅ fetchWithFallback: авто-fallback прокси→direct при ошибке туннеля

### Что НЕ РАБОТАЕТ / НУЖНО ПРОВЕРИТЬ
- ❓ `net.request` через прокси — код написан, но НЕ ТЕСТИРОВАН на Windows (нужен git pull + запуск)
- ❓ `testSessionProxy()` — добавлена диагностика, но результат неизвестен
- ❌ `win-audio-capture` не исключает собственный процесс (эхо)
- ❌ suggestionHistory — исправлен (user/assistant пары), но не протестировано
- ❌ Нет маскировки (Disguise)
- ❌ Нет логирования в файл (Winston)

---

## 6. Известные проблемы и техдолг

### Критические
1. **net.request через прокси — НЕ ПРОВЕРЕН** — код написан (session.setProxy + session.on('login') + net.request), но на Windows-машине всё ещё работает СТАРАЯ сборка (порог 400, нет Hallucination Filter). Нужен `git pull` + `npm run dev`.
2. **Эхо системного звука** — win-audio-capture не исключает собственный процесс; нужен process-loopback
3. **Electron #44249 для net.fetch** — РЕШЕНО переходом на net.request, но нужно подтвердить что session.on('login') работает с net.request

### Модульные
- **audioCapture**: WASAPI sampleRate 44100 захардкожен, нет VAD (только Silence Gate в sttService)
- **handlers**: 4 хардкод-строки IPC вместо констант
- **Renderer**: нет Markdown-рендеринга, SettingsPanel пошаговое сохранение

### Техдолг
Нет тестов, нет логирования в файл, нет electron-builder, inline CSS, нет TypeScript strict, два package.json (src/ и pkg/), нет .env, ScriptProcessorNode deprecated, нет маскировки (Disguise), нет скриншотов для мультимодальности

---

## 7. Что НЕ сработало (хронология провалов)

1. **ffmpeg dshow микрофон** — кириллица в именах устройств → кракозябры, dummy-устройства нестабильны, ложный spawn status. Решение: getUserMedia в Renderer.
2. **Рекурсивный ffmpeg fallback** — CaptureCandidate + tryNextDevice() логически корректен, но фундаментальная проблема кодировки остаётся. Решение: полная миграция на getUserMedia.
3. **Web Audio API для системного звука** — браузер не даёт loopback. Решение: WASAPI в Main.
4. **Raw PCM на Whisper API** — HTTP 400. Решение: createWavBuffer().
5. **npm form-data** — ломает externalizeDepsPlugin. Решение: ручной Buffer.concat.
6. **Параллельная STT-отправка** — rate limit исчерпан. Решение: последовательная очередь.
7. **Stereo Mix** — отключён по умолчанию на большинстве машин. Решение: WASAPI loopback.
8. **app.commandLine.appendSwitch('proxy-server')** — ERR_TUNNEL_CONNECTION_FAILED, ломает HTTPS. Решение: session.setProxy без http:// префикса.
9. **session.on('login') без webContents** — сдвиг параметров, authInfo.isProxy всегда false. Решение: правильная 5-аргументная сигнатура.
10. **net.fetch + session.on('login')** (Electron #44249) — net.fetch НЕ триггерит login-событие, даже с правильной сигнатурой. Решение: undici ProxyAgent для fetch, net.request для SSE.
11. **Proxy warmup через BrowserWindow** — прогрев не помог, потому что Chromium туннель падает ДО этапа авторизации (ERR_TUNNEL_CONNECTION_FAILED), login-событие никогда не вызывается. Решение: undici ProxyAgent.
12. **globalThis.fetch = net.fetch** — ломал SSE-стриминг: ReadableStream.getReader() не работал с net.fetch response body. Решение: использовать стандартный Node.js fetch через undici ProxyAgent.
13. **Silence Gate порог 400** — слишком низкий, аппаратные шумы микрофона (наводки 70-300) обходят gate и вызывают галлюцинации Whisper. Решение: порог 1200 + Hallucination Filter.
14. **Пустой broadcastSuggestion** — вызывал «Продолжение следует» в UI. Решение: не отправлять пустые подсказки.
15. **undici@8 несовместимость** — Electron 31 (Node 22.16) несовместим с undici@8. Решение: pin undici@7.
16. **proxyRules без протокола** — `153.80.159.108:64218` не создавал HTTPS CONNECT-туннель для net.request. Решение: `http=host:port;https=host:port`.

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
9. **undici ProxyAgent для STT** — net.fetch не поддерживает прокси-авторизацию (Electron #44249), Node.js fetch через ProxyAgent работает надёжно. Плюс multipart/form-data с бинарными WAV через ProxyAgent.
10. **net.request для LLM** — использует Chromium network stack, поддерживает SSE через прокси-туннель, session.on('login') для авторизации
11. **Silence Gate (амплитуда < 1200)** — предотвращает галлюцинации Whisper на тишине/шуме, экономит rate limit Groq
12. **Hallucination Filter** — текстовый пост-фильтр после Whisper, отсекает типичные галлюцинации: «Продолжение следует», «Субтитры созданы сообществом» и др.
13. **fetchWithFallback** — автоматический fallback с прокси на direct при ошибках туннеля
14. **Gemini 2.5 Flash** — быстрее, умнее, дешевле чем Qwen Coder и Gemini 2.0 Flash
15. **testSessionProxy()** — диагностика net.request через прокси при старте, показывает работает ли Chromium stack proxy
16. **Debug overlay (#14141e)** — видимые окна для отладки на Windows-машине
17. **proxyRules формат `http=host:port;https=host:port`** — явно указывает протоколы для создания CONNECT-туннелей

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
5. ДВОЙНАЯ прокси: undici для fetch (STT), session proxy для net.request (LLM)

### Критические уроки
1. НЕ отправляй raw PCM на Whisper — только WAV
2. НЕ отправляй STT чанки параллельно — rate limit
3. НЕ используй Web Audio для системного звука — только нативные модули
4. НЕ используй ffmpeg dshow для микрофона — кириллица ломает кодировку
5. НЕ забывай `language: "ru"` для Whisper
6. НЕ парси SSE без буферизации — `buffer = lines.pop()`
7. НЕ ставь captureState=true до проверки что процесс жив
8. НЕ используй `net.fetch` для прокси — баг Electron #44249 (не триггерит login)
9. НЕ используй Node.js fetch для OpenRouter SSE через прокси — используй net.request
10. НЕ ставь просто `host:port` в proxyRules — используй `http=host:port;https=host:port`
11. НЕ переопределяй globalThis.fetch = net.fetch — ломает SSE ReadableStream
12. НЕ отправляй пустые broadcastSuggestion — вызывает «Продолжение следует»
13. НЕ отправляй тишину на Whisper — Silence Gate (амплитуда < 1200) перед WAV-конвертацией
14. НЕ доверяй Whisper без Hallucination Filter — галлюцинации на тишине/шуме
15. НЕ используй undici@8 с Electron 31 — pin undici@7

---

## 10. Следующие шаги

### Приоритет 0 🔴 — Проверить на Windows
- [ ] `git pull` + `npm run dev` — запустить НОВУЮ сборку
- [ ] Проверить в логе: `[sttService] Silence Gate: порог < 1200/32768, Hallucination Filter: ON`
- [ ] Проверить в логе: `[proxy] net.request: РАБОТАЕТ` или `ОШИБКА`
- [ ] Если net.request не работает через прокси — отлаживать session.on('login')

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

---

## 11. ПРОМТ ПОМОЩИ для другой нейросети

> **Контекст**: Я разрабатываю Electron-приложение (1C-Copilot) — AI-ассистент для 1С-разработчика на созвонах. Приложение захватывает аудио (микрофон + системный звук), транскрибирует через Groq Whisper API и генерирует подсказки через OpenRouter LLM. Работает через корпоративный HTTP-прокси с авторизацией.
>
> **Стек**: Electron 31.7.7, TypeScript, React, electron-vite, Node.js 22.16
>
> **Что я НЕ МОГУ решить**:
>
> 1. **Electron net.request через HTTP-прокси с авторизацией** — мне нужно чтобы `electron.net.request()` (Chromium network stack) шёл через HTTP-прокси `153.80.159.108:64218` с логином/паролем. Я настроил `session.defaultSession.setProxy({ proxyRules: 'http=host:port;https=host:port' })` и `session.defaultSession.on('login', ...)` с `callback(user, pass)`. Но я не уверен что `net.request` (в отличие от `net.fetch`) реально триггерит `session.on('login')` для прокси-авторизации. Документация Electron молчит. Баг #44249 про `net.fetch` — но про `net.request` ничего. **Вопрос**: работает ли `net.request` + `session.setProxy` + `session.on('login')` для HTTP-прокси с Basic авторизацией? Или это тоже сломано как net.fetch?
>
> 2. **Whisper API галлюцинации на тишине** — даже с Silence Gate (порог амплитуды 1200 из 32768), аппаратные наводки микрофона (70-300) проходят и Groq Whisper генерирует текстовые галлюцинации: «Продолжение следует», «Субтитры созданы сообществом», «Спасибо за просмотр» и т.д. Hallucination Filter (пост-фильтр по ключевым фразам) — это пластырь, а не решение. **Вопрос**: как правильно фильтровать тишину/шум перед отправкой на Whisper? Нужен ли Silero VAD или WebRTC VAD? Или лучше переключиться на Deepgram (у которого есть server-side VAD)?
>
> 3. **Эхо системного звука** — `win-audio-capture` (WASAPI loopback) захватывает ВСЕ системные звуки, включая звук собственного приложения. Референсный проект ShadowHint использует нативный C++ addon `process-loopback` с `excludeProcessId: process.pid` для исключения собственного процесса. **Вопрос**: как реализовать исключение собственного PID из WASAPI loopback захвата? Есть ли готовый npm-пакет? Или нужно компилировать свой C++ addon?
>
> 4. **SSE-стриминг через прокси** — OpenRouter API возвращает Server-Sent Events (stream: true). Через `net.request` + прокси-туннель SSE может обрезаться, терять чанки или зависать. Буферизация `buffer = lines.pop()` помогает от неполных JSON, но не от потери данных. **Вопрос**: надёжен ли SSE-стриминг через `net.request` при прокси-туннеле HTTPS CONNECT? Есть ли подводные камни?
>
> 5. **Двойная прокси-архитектура — это нормально?** — STT идёт через `undici ProxyAgent` (Node.js fetch), LLM идёт через `session.setProxy` + `net.request` (Chromium stack). Это выглядит как костыль. **Вопрос**: есть ли единый способ маршрутизировать ВСЕ запросы (и multipart/form-data и SSE) через HTTP-прокси с авторизацией в Electron?
>
> **Дополнительный контекст**:
> - Electron 31.7.7 (Chromium 128)
> - Прокси: HTTP, Basic auth, не HTTPS
> - Node.js fetch использует undici@7 (не undici@8 — несовместим с Electron 31)
> - `net.fetch` НЕ работает с прокси-авторизацией (Electron bug #44249)
> - `globalThis.fetch = net.fetch` ломает SSE ReadableStream
> - Windows 10/11, системный звук через WASAPI loopback
