# 01 — Обзор проекта

## Что это

**1C-Copilot** — десктопное overlay-приложение для Windows, которое слушает аудио созвона (микрофон + системный звук), транскрибирует речь в реальном времени через Whisper API и генерирует краткие технические подсказки по 1С:Предприятие 8 через OpenRouter LLM со стримингом. Подсказки отображаются в полупрозрачном overlay поверх всех окон.

## Задача

Помочь 1С-разработчику на технических интервью, созвонах по архитектуре и разборах багов: AI-ассистент анализирует живую речь и выдаёт краткие подсказки — шаблоны кода, особенности БСП, оптимальные индексы, предупреждения о типичных ошибках. Разработчик видит подсказки в реальном времени, не отрываясь от разговора.

## Стек

| Слой | Технология | Версия | Примечание |
|------|-----------|--------|------------|
| Desktop runtime | Electron | 31.7.7 | Main + Renderer + Preload |
| UI | React | 18.3.1 | Функциональные компоненты, хуки |
| Язык | TypeScript | 5.7.2 | strict пока не включён |
| Сборка | electron-vite | 2.3.0 | 3 bundle: main + preload + renderer |
| Bundler (renderer) | Vite | 5.4.11 | React plugin + PostCSS |
| Хранение настроек | electron-store | 8.2.0 | JSON в userData |
| Микрофон (Renderer) | Web Audio API | — | getUserMedia + AudioContext + ScriptProcessorNode |
| Системный звук (Windows) | win-audio-capture | 1.0.1 | WASAPI Loopback (Main-процесс) |
| Системный звук (fallback) | ffmpeg | внешний процесс | dshow / avfoundation / alsa |
| STT | Groq Whisper API / OpenAI Whisper API | whisper-large-v3 / whisper-1 | Multipart WAV → JSON |
| LLM | OpenRouter API | qwen/qwen-2.5-coder-32b-instruct | SSE streaming |
| CSS | Custom CSS Variables (Material Dark) | — | Glass-morphism |

**Где что крутится:**
- **Main-процесс** (Node.js): системный аудио-захват (WASAPI/ffmpeg), STT-очередь, OpenRouter стриминг, IPC-маршрутизация, electron-store
- **Renderer-процесс** (Chromium): React UI + микрофонный захват через getUserMedia + AudioContext (PCM 16kHz/1ch/16-bit)
- **Preload-скрипт**: contextBridge — типобезопасный мост между main и renderer (`window.copilot.*`)

## Ссылки

- **Репо**: https://github.com/Antisakrum2004/copilot
- **API Docs Groq**: https://console.groq.com/docs/speech-text
- **API Docs OpenAI Whisper**: https://platform.openai.com/docs/guides/speech-to-text
- **API Docs OpenRouter**: https://openrouter.ai/docs

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DESKTOP (Windows)                             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    RENDERER-ПРОЦЕСС (Chromium)                 │  │
│  │                                                                │  │
│  │  getUserMedia({audio:true})                                    │  │
│  │       │                                                        │  │
│  │  AudioContext(16000Hz)                                         │  │
│  │       │                                                        │  │
│  │  ScriptProcessorNode(4096)                                     │  │
│  │       │                                                        │  │
│  │  Float32 → Int16 PCM                                          │  │
│  │       │                                                        │  │
│  │  window.copilot.audio.sendMicChunk(ArrayBuffer)               │  │
│  │       │                                                        │  │
│  │  ┌─────────┐  ┌──────────────┐  ┌────────────────┐           │  │
│  │  │ Toolbar │  │ Suggestion   │  │ Transcript     │           │  │
│  │  │ 360×64  │  │ Panel 420×320│  │ Panel 380×420  │           │  │
│  │  └─────────┘  └──────────────┘  └────────────────┘           │  │
│  └──────────────────────────┬─────────────────────────────────────┘  │
│                              │ IPC (contextBridge)                    │
│  ┌──────────────────────────▼─────────────────────────────────────┐  │
│  │                    MAIN-ПРОЦЕСС (Node.js)                      │  │
│  │                                                                │  │
│  │  handleMicChunkFromRenderer() ──→ ChunkBuffer('mic') ──┐      │  │
│  │                                                        │      │  │
│  │  WASAPI Loopback ──→ ChunkBuffer('system') ────────────┤      │  │
│  │  (win-audio-capture / try-catch)                       │      │  │
│  │       │ ffmpeg fallback                                │      │  │
│  │                                                        ▼      │  │
│  │                                              chunkCallback()   │  │
│  │                                                    │           │  │
│  │                                              enqueueChunk()    │  │
│  │                                                    │           │  │
│  │                                              sttService.ts     │  │
│  │                                              (Whisper API)     │  │
│  │                                                    │           │  │
│  │                                         transcription:update   │  │
│  │                                         + triggerAutoSuggestion │  │
│  │                                                    │           │  │
│  │                                           openrouterService.ts │  │
│  │                                           (SSE streaming)      │  │
│  │                                                    │           │  │
│  │                                         suggestion:update-content│ │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Поток данных (детально)

1. Пользователь нажимает **«Слушать»** на Toolbar
2. Renderer вызывает `window.copilot.audio.startStreams()` + `startNativeLoopback()`
3. IPC `audio:startStreams` → handlers.ts → сигнал Renderer'у начать getUserMedia (`audio:micCaptureStart`)
4. IPC `audio:startNativeLoopback` → handlers.ts → audioCapture.startCapture('system')
5. **Renderer**: `useMicCapture` hook активируется → `getUserMedia({audio:true})` → `AudioContext({sampleRate:16000})` → `ScriptProcessorNode` → Float32→Int16 PCM → `window.copilot.audio.sendMicChunk(ArrayBuffer)` → IPC `audio:sendMicChunk`
6. **Main**: `handleMicChunkFromRenderer()` → `ChunkBuffer('mic')`
7. **Main**: WASAPI loopback / ffmpeg fallback → `ChunkBuffer('system')`
8. ChunkBuffer'ы накапливают данные до 6 секунд (192 000 байт), затем вызывают `chunkCallback(source, chunk, sampleRate, channels)`
9. `chunkCallback` в handlers.ts вызывает `enqueueChunk()` → sttService.ts
10. sttService оборачивает PCM в WAV (44-байт заголовок), отправляет multipart/form-data на Groq/OpenAI Whisper
11. Результат → `transcription:update` IPC → TranscriptPanel + накопление контекста
12. При паузе 2с после системного чанка → `triggerAutoSuggestion()` → OpenRouter SSE streaming
13. SSE-токены → `suggestion:update-content` IPC → SuggestionPanel

## Ключевые зависимости

| Зависимость | Роль | Критичность |
|-------------|------|-------------|
| `electron` | Desktop runtime | Критическая — без неё нет приложения |
| `electron-vite` | Сборка main + preload + renderer | Критическая — сборка |
| `electron-store` | Персистентное хранение настроек | Высокая — без неё теряются API ключи |
| `win-audio-capture` | Нативный WASAPI loopback (Windows) | Высокая — единственный надёжный способ захвата системного звука |
| `react` / `react-dom` | UI renderer | Высокая — весь UI на React |
| `ffmpeg` (внешний) | Fallback аудио-захват (системный звук) | Средняя — нужен если win-audio-capture не работает |
| Groq API | STT (быстрый, бесплатный до лимитов) | Высокая — основной STT |
| OpenRouter API | LLM (стриминг подсказок) | Высокая — генерация подсказок |
| Web Audio API | Микрофонный захват в Renderer | Критическая — единственный стабильный способ захвата микрофона |
