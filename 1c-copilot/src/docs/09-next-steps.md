# 09 — Следующие шаги

## Приоритет 0 — Исправить 5 ошибок TS-тайпчека 🔴

Без этого `npm run typecheck` падает, и любая IDE показывает красные ошибки.

- [ ] **Добавить `import { useState, useEffect } from 'react'`** в `SuggestionPanel.tsx`
- [ ] **Добавить `import { useState, useEffect } from 'react'`** в `TranscriptPanel.tsx`
- [ ] **Заменить `import React from 'react'`** на `import * as React from 'react'` в `main.tsx`
- [ ] **Запустить `npm run typecheck`** — убедиться что 0 ошибок

## Приоритет 1 — Завершить рефакторинг audioCapture.ts 🔴

Захват микрофона через getUserMedia реализован в `useMicCapture.ts`, но audioCapture.ts всё ещё содержит мёртвый ffmpeg-mic код.

- [ ] **Удалить мёртвый ffmpeg-mic код** из `audioCapture.ts` — убрать `startFallbackCapture('mic', ...)`, `ffmpegMicProcess`, весь dshow-код для микрофона
- [ ] **Обернуть WASAPI код в try/catch** — если win-audio-capture не загружен или драйвер занят, приложение должно работать в режиме «только микрофон»
- [ ] **Инициализировать `systemChunkBuf` ДО** вызова `startNativeLoopbackCapture()` — чтобы при "already running" буфер существовал
- [ ] **Протестировать flow**: Renderer getUserMedia → IPC `audio:sendMicChunk` → `handleMicChunkFromRenderer()` → ChunkBuffer('mic') → callback → sttService

## Приоритет 2 — Исправить баги захвата и буферов 🟡

- [ ] **Ложный `true` при spawn ffmpeg** — заменить мгновенный `return true` на промис с ожиданием 1-2 секунды и проверкой что процесс жив
- [ ] **Баг `systemChunkBuf` при "already running"** — создавать ChunkBuffer до проверки "already running" (связано с Приоритет 1)
- [ ] **Удалить дублирующую отправку** в sttService.ts `broadcastTranscription` — убрать `getWindow()` вызов, оставить только `getAllWindows()`
- [ ] **Исправить suggestionHistory** в openrouterService.ts — хранить пары user/assistant, а не только assistant
- [ ] **Проверить fetch() с Buffer body** — если не работает, заменить на Uint8Array

## Приоритет 3 — Overlay-окна: отладка и продакшен-режим 🟡

- [ ] **Проверить debug-режим**: непрозрачные окна с `#14141e` фоном и рамкой видны на Windows
- [ ] **Реализовать переключатель** debug/production режима для overlay-окон
- [ ] **Вернуть прозрачность** в production: `transparent: true`, `backgroundColor: '#02000000'`, `focusable: false`, `frame: false`
- [ ] **Протестировать click-through логику**: mouseenter → clickable, mouseleave → click-through

## Приоритет 4 — Локальный запуск на Windows-машине 🟡

Проект ни разу не запускался на реальном GUI. Это критический шаг — нужно увидеть что всё работает.

- [ ] **`npm run dev` на Windows** — проверить что Electron открывается с 3 окнами
- [ ] **Протестировать getUserMedia** — проверить что микрофон захватывается, PCM чанки идут через IPC
- [ ] **Протестировать WASAPI** — проверить что системный звук захватывается через win-audio-capture
- [ ] **Протестировать с Groq API** — получить ключ, запустить полный цикл: микрофон → STT → транскрипция
- [ ] **Протестировать с OpenRouter API** — проверить streaming подсказок
- [ ] **Протестировать ffmpeg fallback** — проверить что системный звук захватывается через ffmpeg если WASAPI недоступен

## Приоритет 5 — Базовая функциональность 🟢

- [ ] **Markdown-рендеринг** в SuggestionPanel (react-markdown или marked)
- [ ] **Горячие клавиши** (global shortcuts) для старта/останова
- [ ] **Системный трей** — сворачивание вместо закрытия
- [ ] **Редактор системного промпта** в настройках
- [ ] **Настройка temperature/max_tokens** в UI
- [ ] **Заменить хардкод-строки IPC** в handlers.ts на IPC-константы

## Приоритет 6 — Чистка / рефакторинг ⚪

- [ ] Вынести inline-стили в CSS Modules
- [ ] Включить TypeScript strict mode
- [ ] Единый логгер с записью в файл
- [ ] Удалить `pkg/` директорию или синхронизировать с основным package.json
- [ ] VAD (Voice Activity Detection) — не отправлять тишину на STT
- [ ] Мигрировать ScriptProcessorNode → AudioWorkletNode в useMicCapture.ts
- [ ] Обновить `version` в package.json с `0.1.0` на `1.0.0`

## Приоритет 7+ — Будущее ⚪

- [ ] electron-builder упаковка
- [ ] Автообновление (electron-updater)
- [ ] Тесты
- [ ] CI/CD
- [ ] Множественные мониторы
- [ ] Выбор аудио-устройств в UI
- [ ] Поддержка других языков (кроме русского) в STT
