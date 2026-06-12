# 04 — Текущее состояние

## Версия

**V1.0.0** — Рабочий прототип. Код написан, проект успешно компилируется через `electron-vite build`. Аудио-пайплайн логически спроектирован с разделением микрофона (Renderer getUserMedia) и системного звука (Main WASAPI/ffmpeg). Есть 5 ошибок typecheck, блокирующих полную типизацию. Рантайм не тестировался на реальном GUI.

## Статус сборки: ПРОЕКТ СОБИРАЕТСЯ ✅

- **Все npm-зависимости установлены** (npm install завершён; win-audio-capture — Windows-only, компилируется с ожидаемой ошибкой на Linux)
- **`tsconfig.node.json` и `tsconfig.web.json`** — созданы и корректны
- **`electron-vite build`** — УСПЕШНО: main (387 модулей, 367KB), preload (2 модуля, 5.3KB), renderer (34 модуля, 231KB)
- **`electron-vite dev`** — компиляция проходит, Electron dev не запускается на headless-сервере (нет X11/GTK — ожидаемо)
- **`npm run typecheck`** — 5 ошибок (3× TS2304: useState не импортирован, 2× TS1259/TS1192: default import React)

## Статус typecheck: 5 ОШИБОК ❌

| Файл | Строка | Код | Описание |
|------|--------|-----|----------|
| `SuggestionPanel.tsx` | 13 | TS2304 | Cannot find name 'useState' |
| `SuggestionPanel.tsx` | 19 | TS2304 | Cannot find name 'useState' |
| `TranscriptPanel.tsx` | 19 | TS2304 | Cannot find name 'useState' |
| `main.tsx` | 1 | TS1259 | Module can only be default-imported using 'allowSyntheticDefaultImports' |
| `main.tsx` | 2 | TS1192 | Module has no default export |

**Решение**: Добавить `import { useState, useEffect } from 'react'` в SuggestionPanel.tsx и TranscriptPanel.tsx; заменить `import React from 'react'` на `import * as React from 'react'` в main.tsx.

## Реальный статус по модулям

### ✅ Написано и выглядит корректно (но НЕ тестировалось с реальными API)

| Модуль | Строк | Статус |
|--------|-------|--------|
| `main/index.ts` | 41 | Написан. cleanup() на before-quit подключён |
| `main/ipc/handlers.ts` | 378 | Написан. 30+ IPC обработчиков. 4 хардкод-строки |
| `main/store/settings.ts` | 23 | Написан. Рабочий |
| `main/windows/overlayWindow.ts` | 144 | Написан. Debug-режим: непрозрачные окна с рамкой |
| `shared/ipc.ts` | 101 | Написан. 30+ каналов, типы, DEFAULT_SETTINGS |
| `preload/index.ts` | 142 | Написан. 5 namespace API через contextBridge |
| `renderer/src/App.tsx` | 62 | Написан. Hash-роутинг + useMicCapture |
| `renderer/src/hooks/useMicCapture.ts` | 142 | Написан. getUserMedia → AudioContext(16kHz) → PCM Int16 → IPC |
| `renderer/src/components/Toolbar.tsx` | 79 | Написан. Кнопки подключены к IPC |
| `renderer/src/components/SettingsPanel.tsx` | 183 | Написан. Сохранение настроек |
| `renderer/src/styles/theme.css` | 52 | Material Dark палитра |
| `renderer/src/styles/global.css` | 95 | Reset + glass-классы |
| `renderer/src/env.d.ts` | 11 | Тип Window.copilot |
| `electron.vite.config.ts` | 27 | Алиасы + externalizeDeps |

### ⚠️ Написано, содержит баги

| Модуль | Строк | Проблема |
|--------|-------|----------|
| `services/audioCapture.ts` | 552 | Ложный true при spawn ffmpeg. systemChunkBuf null при "already running". ffmpeg mic DISABLED (перейдено на getUserMedia, но старый код не удалён) |
| `services/sttService.ts` | 308 | broadcastTranscription дублирует сообщения. fetch() с Buffer body. Нет retry. |
| `services/openrouterService.ts` | 293 | suggestionHistory без user-пар — нарушает формат OpenAI chat. Промпт зашит. |
| `SuggestionPanel.tsx` | 138 | Нет import useState. Нет Markdown-рендеринга. |
| `TranscriptPanel.tsx` | 118 | Нет import useState. |
| `main.tsx` | — | Кривой import React (default import вместо namespace) |

### ❌ Полностью отсутствует

| Что | Описание |
|-----|----------|
| electron-builder конфиг | Нет возможности создать установщик |
| Тесты | Ни одного теста |
| CI/CD | Не настроен |
| .env пример | Нет шаблона для API ключей разработки |
| Markdown-рендеринг | SuggestionPanel показывает plain text |
| VAD | Нет Voice Activity Detection — тишина отправляется на STT |

## Что по факту сейчас есть в коде

**Каркас Electron-приложения с компилирующимися сервисами и реорганизованным аудио-пайплайном.** Проект успешно собирается. Ключевое архитектурное изменение реализовано: микрофонный захват перенесён из Main (ffmpeg dshow) в Renderer (getUserMedia + AudioContext). Системный звук остаётся в Main через WASAPI/ffmpeg. Остаются баги typecheck, дубли в sttService, ложный spawn-status в audioCapture.

## История версий

**V1.0.0 (июнь 2026)**: Все модули написаны. Проект собирается. Аудио-пайплайн реорганизован: микрофон через getUserMedia в Renderer, системный звук через WASAPI в Main. Overlay-окна в debug-режиме (непрозрачные с рамкой). 5 ошибок typecheck. Рантайм не тестировался.

**v0.0.1-alpha (ЭТАП 2)**: Исправлены критические баги: WASAPI loopback оживлён, ffmpeg-процессы управляются корректно, cleanup при выходе зарегистрирован, startCapture() возвращает false при ошибке.

**v0.0.1-alpha (ЭТАП 1)**: Проект впервые собран. Созданы tsconfig.node.json и tsconfig.web.json. npm install выполнен. electron-vite build успешен.

**v0.0.1-alpha-pre**: Код написан, но не компилировался и не запускался. Зависимости не установлены, конфиги отсутствуют.

## Не реализовано

- [x] WASAPI loopback — мёртвый код → ИСПРАВЛЕНО (ЭТАП 2)
- [x] ffmpeg zombie-процессы → ИСПРАВЛЕНО (ЭТАП 2)
- [x] cleanup() не зарегистрирован → ИСПРАВЛЕНО (ЭТАП 2)
- [x] startCapture() всегда true → ИСПРАВЛЕНО (ЭТАП 2)
- [x] ffmpeg dshow микрофон → ЗАМЕНЕНО на getUserMedia в Renderer (V1.0.0)
- [ ] 5 ошибок typecheck (useState, React import)
- [ ] Ни один сервис не тестировался с реальными API
- [ ] Markdown-рендеринг в SuggestionPanel
- [ ] Глобальные горячие клавиши
- [ ] Системный трей
- [ ] Автообновление
- [ ] Упаковка в установщик
- [ ] Тесты
