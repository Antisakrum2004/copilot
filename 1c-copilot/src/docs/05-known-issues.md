# 05 — Известные проблемы и техдолг

## Критические проблемы (блокируют typecheck / runtime)

### 1. 5 ошибок TypeScript компиляции

**Симптом**: `npm run typecheck` падает с 5 ошибками.

| # | Файл | Строка | Код | Описание |
|---|------|--------|-----|----------|
| 1 | `SuggestionPanel.tsx` | 13 | TS2304 | Cannot find name 'useState' |
| 2 | `SuggestionPanel.tsx` | 19 | TS2304 | Cannot find name 'useState' |
| 3 | `TranscriptPanel.tsx` | 19 | TS2304 | Cannot find name 'useState' |
| 4 | `main.tsx` | 1 | TS1259 | Module can only be default-imported using 'allowSyntheticDefaultImports' |
| 5 | `main.tsx` | 2 | TS1192 | Module has no default export |

**Причина**: В SuggestionPanel.tsx и TranscriptPanel.tsx используется `useState` и `useEffect` без импорта. В main.tsx используется `import React from 'react'` (default import), но React не имеет default export в ES-модульном окружении TypeScript.

**Решение**:
- Добавить `import { useState, useEffect } from 'react'` в SuggestionPanel.tsx и TranscriptPanel.tsx
- Заменить `import React from 'react'` на `import * as React from 'react'` в main.tsx

**Статус**: Открыто (Приоритет 0)

---

### 2. Ложный `true` при spawn ffmpeg процесса

**Симптом**: `startFallbackCapture()` возвращает `true` после успешного `child_process.spawn()`, но ffmpeg может упасть через 0.5 секунды. `captureState[source]` уже установлен в `true`, и внешние системы считают захват активным.

**Почему критично**: Пользователь видит «Слушаю», но реального захвата нет. STT-очередь пуста, подсказки не генерируются. Нет никакого сигнала об ошибке.

**Причина**: spawn() асинхронен по своей природе — успешный вызов spawn означает только что процесс создан, но не что он работает. Нужно ждать хотя бы 1-2 секунды и проверять что процесс не упал (событие `exit` или `error`).

**Решение**: Заменить мгновенный `return true` на промис, который резолвится через 1-2 секунды если процесс жив, или реджектится если процесс упал.

**Статус**: Открыто (Приоритет 2)

---

### 3. `systemChunkBuf` null при повторном старте WASAPI

**Симптом**: При повторном вызове `startCapture('system')` если WinAudioCapture выбрасывает "already running", код устанавливает `nativeCaptureActive = true` и возвращает `true`, но `systemChunkBuf` остаётся `null` (не инициализирован в этом code path). Последующие чанки от WASAPI не буферизуются.

**Почему критично**: Системный звук «слушается», но чанки теряются — STT не получает данных.

**Причина**: Ветка "already running" в `startNativeLoopbackCapture()` обрабатывает ошибку, но не создаёт ChunkBuffer. Нужно инициализировать `systemChunkBuf` до проверки "already running".

**Решение**: Создавать `systemChunkBuf = new ChunkBuffer('system', ...)` в начале `startCapture('system')` до вызова `startNativeLoopbackCapture()`.

**Статус**: Открыто (Приоритет 2)

---

## Проблемы конкретных модулей

### sttService.ts

- **Дублирование отправки**: `broadcastTranscription()` сначала отправляет через `getWindow()`, потом через `BrowserWindow.getAllWindows()`. Если getWindow() возвращает то же окно — сообщение дублируется в renderer. Это приводит к двойному отображению строк в TranscriptPanel.
- **fetch() с Buffer body**: Нативный `fetch()` в Node.js ожидает `ArrayBuffer`/`TypedArray`, а не `Buffer`. Может потребоваться `new Uint8Array(body)` или использование `Blob`.
- **Нет retry**: при ошибке сети или 429 от Groq чанк теряется навсегда. В условиях rate limit это может привести к пропуску значимых фрагментов речи.

### openrouterService.ts

- **suggestionHistory нарушает формат чата**: Хранятся только `assistant` сообщения, но OpenAI chat API требует чередование `user`/`assistant`. Если отправить `[system, assistant, assistant, user]` — API может вернуть ошибку или галлюцинировать.
- **Системный промпт зашит**: Нельзя изменить без пересборки.
- **temperature/max_tokens захардкожены**: Нельзя настроить через UI.

### audioCapture.ts

- **Старый ffmpeg mic-код не удалён**: После перехода на getUserMedia, ffmpeg-захват микрофона отключён (код закомментирован/обойдён), но мёртвый код остаётся в файле. Нужно полностью удалить `startFallbackCapture('mic', ...)` логику.
- **WASAPI sample rate 44100 захардкожен**: На некоторых системах 48000 или 96000.
- **Нет VAD**: Все чанки отправляются на STT, включая тишину. Это расходует API-лимиты и добавляет шум в транскрипцию.

### handlers.ts

- **4 IPC-хендлера используют хардкод-строки** вместо IPC-констант: `'suggestion:request'`, `'suggestion:abort'`, `'transcript:getCurrent'`, `'suggestion:isStreaming'`. Значения совпадают с ipc.ts, но если изменить константу — хендлер сломается молча.

### Renderer

- **SuggestionPanel не рендерит Markdown**: Показывает raw text с mono-шрифтом. Подсказки LLM в Markdown выглядят как `### Заголовок\n**жирный**\n- список`.
- **main.tsx: кривой React import**: `import React from 'react'` вместо `import * as React from 'react'`.
- **SettingsPanel: пошаговое сохранение**: Каждая настройка сохраняется отдельным `ipcRenderer.invoke()`. Если приложение упадёт между вызовами — часть настроек потеряется.

---

## Проблема кодировки кириллицы в ffmpeg (ИСТОРИЧЕСКАЯ, решена миграцией)

**Симптом**: При передаче кириллических имён устройств (типа "Микрофон (Realtek Audio)") в `ffmpeg -f dshow -i audio=...` через `child_process.spawn()`, имена превращались в кракозябры из-за несовместимости кодировок UTF-16 (Windows) / UTF-8 (Node.js) / ANSI (ffmpeg dshow).

**Решение**: Полный отказ от ffmpeg dshow для микрофона. Переход на `navigator.mediaDevices.getUserMedia()` в Renderer-процессе, где Chromium сам управляет кодировками и не зависит от системных проблем Windows.

**Статус**: Закрыто (решено архитектурно — см. `07-decisions.md`)

---

## Технический долг

1. **НЕТ ТЕСТОВ**: ни unit, ни integration. Весь код — untested.
2. **Нет логирования в файл**: только console.log. При отладке на Windows не видно логов Main-процесса без DevTools.
3. **Нет упаковки**: нет electron-builder конфигурации.
4. **Стили inline**: CSS внутри компонентов через `<style>` тег. Нет CSS Modules.
5. **Нет TypeScript strict**: tsconfig не включает `strict: true`.
6. **Два package.json**: `src/package.json` и `pkg/package.json` — с разными зависимостями. Нужно синхронизировать или удалить pkg/.
7. **Нет .env**: нет шаблона для API ключей разработки.
8. **Нет Markdown-рендеринга**: подсказки LLM отображаются как plain text.
9. **Нет hotkey**: нет глобальных горячих клавиш.
10. **ScriptProcessorNode deprecated**: нужно мигрировать на AudioWorkletNode.
11. **Мёртвый ffmpeg-mic код**: после миграции на getUserMedia старый код захвата микрофона через ffmpeg не удалён из audioCapture.ts.
