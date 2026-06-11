# 01 — Обзор проекта

## Что это

**1C-Copilot** — десктопное overlay-приложение для Windows, которое слушает аудио созвона (микрофон + системный звук), транскрибирует речь в реальном времени через Whisper API и генерирует краткие технические подсказки по 1С:Предприятие 8 через OpenRouter LLM со стримингом. Подсказки отображаются в полупрозрачном overlay поверх всех окон.

## Задача

Помочь 1С-разработчику на технических интервью, созвонах по архитектуре и разборах багов: AI-ассистент анализирует живую речь и выдаёт краткие подсказки — шаблоны кода, особенности БСП, оптимальные индексы, предупреждения о типичных ошибках. Разработчик видит подсказки в реальном времени, не отрываясь от разговора.

## Стек

| Слой | Технология | Версия |
|------|-----------|--------|
| Desktop runtime | Electron | 31.7.7 |
| UI | React | 18.3.1 |
| Язык | TypeScript | 5.7.2 |
| Сборка | electron-vite | 2.3.0 |
| Bundler (renderer) | Vite | 5.4.11 |
| Хранение настроек | electron-store | 8.2.0 |
| Аудио-захват (Windows) | win-audio-capture | 1.0.3 |
| Аудио-захват (fallback) | ffmpeg | внешний процесс |
| STT | Groq Whisper API / OpenAI Whisper API | whisper-large-v3 / whisper-1 |
| LLM | OpenRouter API | qwen/qwen-2.5-coder-32b-instruct |
| CSS | Custom CSS Variables (Material Dark) | — |

**Где что крутится:**
- **Main-процесс** (Node.js): аудио-захват, STT-очередь, OpenRouter стриминг, IPC-маршрутизация, electron-store
- **Renderer-процесс** (Chromium): React UI — toolbar, suggestion panel, transcript panel
- **Preload-скрипт**: contextBridge — типобезопасный мост между main и renderer

## Ссылки

- **Продакшен**: N/A (десктопное приложение, распространяется как .exe / установщик)
- **Репо**: TBD (локальный репозиторий)
- **API Docs Groq**: https://console.groq.com/docs/speech-text
- **API Docs OpenAI Whisper**: https://platform.openai.com/docs/guides/speech-to-text
- **API Docs OpenRouter**: https://openrouter.ai/docs

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                        DESKTOP (Windows)                        │
│                                                                 │
│  ┌──────────┐    ┌───────────┐    ┌──────────┐   ┌───────────┐ │
│  │  WASAPI   │───▶│  Chunk    │───▶│  STT     │──▶│ OpenRouter│ │
│  │ Loopback  │    │  Buffer   │    │  Queue   │   │ Streaming │ │
│  │ + Mic     │    │  (6s)     │    │ (Groq/   │   │ (SSE)     │ │
│  └──────────┘    └───────────┘    │  OAI)    │   └─────┬─────┘ │
│       ▲                           └────┬─────┘         │       │
│       │ ffmpeg fallback                 │               │       │
│       │                                 ▼               ▼       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    IPC (electron)                        │   │
│  │  transcription:update          suggestion:update-content │   │
│  └────────────┬──────────────────────────┬─────────────────┘   │
│               │                          │                      │
│               ▼                          ▼                      │
│  ┌─────────────────┐    ┌──────────────────────┐               │
│  │ TranscriptPanel │    │  SuggestionPanel      │               │
│  │ (overlay окно)  │    │  (overlay окно)        │               │
│  └─────────────────┘    └──────────────────────┘               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Toolbar (overlay окно: Слушать/Стоп, Настройки)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  SettingsPanel (API ключи, провайдер, модель, opacity)   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Ключевые зависимости

| Зависимость | Роль | Критичность |
|-------------|------|-------------|
| `electron` | Desktop runtime | Критическая — без неё нет приложения |
| `electron-vite` | Сборка main + preload + renderer | Критическая — сборка |
| `electron-store` | Персистентное хранение настроек | Высокая — без неё теряются API ключи |
| `win-audio-capture` | Нативный WASAPI loopback (Windows) | Высокая — основной способ захвата системного звука на Windows |
| `react` / `react-dom` | UI renderer | Высокая — весь UI на React |
| `ffmpeg` (внешний) | Fallback аудио-захват | Средняя — нужен если win-audio-capture не работает |
| Groq API | STT (быстрый, бесплатный до лимитов) | Высокая — основной STT |
| OpenRouter API | LLM (стриминг подсказок) | Высокая — генерация подсказок |

## Как идут данные

1. Пользователь нажимает **«Слушать»** на Toolbar
2. Renderer вызывает `window.copilot.audio.startStreams()` + `startNativeLoopback()`
3. IPC `audio:startStreams` / `audio:startNativeLoopback` → handlers.ts
4. **audioCapture.ts** запускает WASAPI loopback (или ffmpeg fallback)
5. Аудио нарезается на чанки по 6 секунд (16kHz Mono 16-bit PCM, 192KB)
6. Каждый чанк → callback `chunkCallback(source, chunk, sampleRate, channels)`
7. Callback в handlers.ts (`setupAudioPipeline`) вызывает `enqueueChunk()`
8. **sttService.ts** ставит чанк в очередь, последовательно отправляет на Whisper API
9. PCM оборачивается в WAV (44-байтный заголовок), отправляется как multipart/form-data
10. Результат транскрипции → `transcription:update` IPC → TranscriptPanel + накопление контекста
11. При паузе в разговоре (2с после последней транскрипции) → `triggerAutoSuggestion()`
12. **openrouterService.ts** отправляет накопленный текст на OpenRouter с `stream: true`
13. SSE-токены приходят по одному → `suggestion:update-content` IPC → SuggestionPanel
14. SuggestionPanel отображает подсказку в реальном времени (Markdown)
15. Пользователь может нажать **«Спросить ИИ»** для ручного запроса или **«Стоп»** для прерывания
