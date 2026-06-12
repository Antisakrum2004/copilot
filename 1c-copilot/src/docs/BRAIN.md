# 1C-Copilot — Memory Bank (V1.1.0, обновлено 2026-06-13)

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
| LLM | OpenRouter API | qwen/qwen-2.5-coder-32b-instruct |
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
6. sttService: PCM → WAV (44 байта заголовок) → multipart/form-data → Groq/OpenAI Whisper
7. Результат → `transcription:update` IPC → TranscriptPanel
8. При паузе 2с → `triggerAutoSuggestion()` → OpenRouter SSE → `suggestion:update-content` → SuggestionPanel

---

## 2. Ловушки внешних API

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

## 3. Модули проекта

### Main-процесс

| Файл | Строки | Роль |
|------|--------|------|
| `index.ts` | 55 | Точка входа. Single-instance lock, undici ProxyAgent, cleanup на before-quit |
| `ipc/handlers.ts` | 378 | 30+ IPC обработчиков. Пайплайн audio→STT→LLM |
| `services/audioCapture.ts` | 552 | Mic: IPC от Renderer. System: WASAPI/ffmpeg. ChunkBuffer 6с |
| `services/sttService.ts` | 308 | Очередь → Whisper API. БАГ: дубли broadcastTranscription |
| `services/openrouterService.ts` | 293 | SSE streaming. БАГ: suggestionHistory без user-пар |
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
| `TranscriptPanel.tsx` | Расшифровка. БАГ: нет import useState |
| `SettingsPanel.tsx` | API ключи, провайдер, модель, opacity/width |

---

## 4. Текущее состояние

**V1.1.0** — Проект собирается (`electron-vite build` OK). Аудио-пайплайн реорганизован: микрофон через getUserMedia в Renderer, системный звук через WASAPI в Main. Прокси переведён на `undici ProxyAgent` (вместо сломанного Chromium `net.fetch`). Рантайм тестируется на Windows.

### Статус typecheck: 5 ОШИБОК
| Файл | Код | Описание |
|------|-----|----------|
| SuggestionPanel.tsx | TS2304 | Нет import useState |
| TranscriptPanel.tsx | TS2304 | Нет import useState |
| main.tsx | TS1259/TS1192 | default import React вместо namespace |

### История
- **V1.1.0**: Прокси переписан на undici ProxyAgent (Chromium net.fetch не работал с прокси-авторизацией)
- **V1.0.0**: getUserMedia миграция, proxy session.setProxy, warmup hack, debug overlay
- **v0.0.1-alpha ЭТАП 2**: WASAPI оживлён, ffmpeg zombie fixed, cleanup зарегистрирован
- **v0.0.1-alpha ЭТАП 1**: Первый успешный билд, tsconfig созданы, npm install

---

## 5. Известные проблемы и техдолг

### Критические
1. **5 ошибок TS** — нет import useState в панелях, кривой import React
2. **Ложный `true` при spawn ffmpeg** — captureState ставится до проверки что процесс жив
3. **systemChunkBuf null при "already running"** — ChunkBuffer не создаётся в этой ветке

### Модульные
- **sttService**: дубли broadcastTranscription, fetch() с Buffer body, нет retry
- **openrouterService**: suggestionHistory без user-пар — нарушает формат chat
- **audioCapture**: мёртвый ffmpeg-mic код не удалён, WASAPI sampleRate 44100 захардкожен, нет VAD
- **handlers**: 4 хардкод-строки IPC вместо констант
- **Renderer**: нет Markdown-рендеринга, SettingsPanel пошаговое сохранение

### Техдолг
Нет тестов, нет логирования в файл, нет electron-builder, inline CSS, нет TypeScript strict, два package.json (src/ и pkg/), нет .env, ScriptProcessorNode deprecated

---

## 6. Что НЕ сработало

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

---

## 7. Решения и обоснования

1. **getUserMedia вместо ffmpeg dshow** — изоляция от кодировок Windows, стабильный stream, стандартный API
2. **WASAPI в try/catch** — graceful degradation: нет системного звука → работаем с микрофоном
3. **Electron вместо web** — нужен overlay + системный звук
4. **3 отдельных окна** — независимая видимость/позиция/прозрачность
5. **Hash-based роутинг** — один bundle, простая сборка
6. **6-секундные чанки** — баланс качества Whisper и задержки
7. **Ручной multipart** — без зависимостей, полный контроль
8. **Последовательная STT-очередь** — rate limit + порядок результатов
9. **undici ProxyAgent вместо Chromium proxy** — net.fetch не поддерживает прокси-авторизацию (Electron #44249), Node.js fetch через ProxyAgent работает надёжно
10. **Debug overlay (#14141e)** — видимые окна для отладки на Windows-машине

---

## 8. Как писать код

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

---

## 9. Следующие шаги

### Приоритет 0 🔴 — Typecheck
- [ ] Добавить `import { useState, useEffect } from 'react'` в SuggestionPanel.tsx и TranscriptPanel.tsx
- [ ] Заменить `import React from 'react'` на `import * as React from 'react'` в main.tsx

### Приоритет 1 🔴 — audioCapture рефакторинг
- [ ] Удалить мёртвый ffmpeg-mic код
- [ ] Обернуть WASAPI в try/catch
- [ ] Инициализировать systemChunkBuf до startNativeLoopbackCapture()

### Приоритет 2 🟡 — Баги
- [ ] Ложный true при spawn ffmpeg → промис с ожиданием
- [ ] Дубли broadcastTranscription → убрать getWindow()
- [ ] suggestionHistory → пары user/assistant
- [ ] fetch() Buffer body → Uint8Array

### Приоритет 3 🟡 — Overlay
- [ ] Переключатель debug/production режима
- [ ] Production: transparent, #02000000, focusable: false, frame: false

### Приоритет 4 🟡 — Windows runtime
- [ ] Полный цикл: микрофон → STT → транскрипция → LLM → подсказки
- [ ] Проверить прокси через undici ProxyAgent (смотреть [Proxy] в логах)

### Приоритет 5+ 🟢
- [ ] Markdown-рендеринг, горячие клавиши, системный трей, VAD, тесты, electron-builder
