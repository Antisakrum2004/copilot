---
Task ID: 1
Agent: main
Task: Создать накопительный банк памяти (9 Markdown + INDEX.json) для проекта 1C-Copilot

Work Log:
- Нашёл проект 1C-Copilot в /home/z/my-project/1c-copilot/src/
- Прочитал все 21 файл проекта (main, preload, renderer, shared, config)
- Проанализировал архитектуру, зависимости, IPC-каналы, API-интеграции
- Создал /docs/ директорию в /home/z/my-project/1c-copilot/src/docs/
- Создал INDEX.json с quick_facts, files, docs, critical_first
- Создал 01-overview.md — обзор проекта, ASCII-схема архитектуры, поток данных
- Создал 02-api-quirks.md — ловушки Groq Whisper, OpenAI Whisper, OpenRouter API
- Создал 03-modules.md — описание всех 21 файла проекта с функциями и связями
- Создал 04-current-state.md — V100, реализовано, не реализовано
- Создал 05-known-issues.md — 3 критические проблемы, баги модулей, 10 пунктов техдолга
- Создал 06-attempts-failures.md — 7 провалов и обходных путей
- Создал 07-decisions.md — 10 архитектурных решений с обоснованиями и альтернативами
- Создал 08-coding-rules.md — стиль, API, рендеринг, CSS, принципы, 10 критических уроков
- Создал 09-next-steps.md — приоритизированный список задач (P0-P5+)

Stage Summary:
- Создано 10 файлов (9 .md + INDEX.json) в /home/z/my-project/1c-copilot/src/docs/
- Общий объём: ~94KB документации
- Все файлы заполнены реальными данными проекта, без плейсхолдеров
- INDEX.json содержит 22 quick_facts для быстрого контекста
- Версия проекта: V100
---
Task ID: 2
Agent: main
Task: Фикс typecheck + микрофон через getUserMedia + debug-видимость окон + build+push

Work Log:
- SHAГ 1: main.tsx — исправлен React default import на `import * as React from 'react'`
- SuggestionPanel.tsx, TranscriptPanel.tsx — уже содержат правильные импорты
- ШАГ 2: audioCapture.ts полностью переписан:
  - Микрофон: убран ffmpeg/dshow, захват через getUserMedia в Renderer
  - Новый хук useMicCapture.ts: getUserMedia → AudioContext(16kHz) → ScriptProcessor → Float32→Int16 → IPC
  - handleMicChunkFromRenderer() приём PCM от Renderer
  - Системный звук: WASAPI + ffmpeg fallback, обёрнуто в try/catch
- shared/ipc.ts: +3 канала (micCaptureStart, micCaptureStop, sendMicChunk)
- preload/index.ts: +3 метода (onMicCaptureStart, onMicCaptureStop, sendMicChunk)
- handlers.ts: +ipcMain.on(sendMicChunk), try/catch вокруг startCapture, broadcast micCaptureStart/Stop
- App.tsx: подключён хук useMicCapture()
- ШАГ 3: overlayWindow.ts — suggestion/transcript: frame:true, transparent:false, bg:'#14141e'
- handlers.ts: убраны hide() для suggestionWindow/transcriptWindow (окна видны при старте)
- ШАГ 4: npm run build — УСПЕШНО (main 37.5KB, preload 5.86KB, renderer 235KB)
- Коммит d7f30e5, force push в main

Stage Summary:
- Микрофон перенесён в Renderer (getUserMedia + AudioContext + IPC)
- Окна видны при старте (тёмный фон + рамка)
- Сборка зелёная
- Коммит d7f30e5 запушен в main
