# 08 — Как писать код

## Язык

- **TypeScript 5.7+** — строгая типизация, **запрет на использование `any`** (кроме крайних случаев с комментарием-обоснованием)
- **React 18** — функциональные компоненты, хуки
- **Node.js** (Electron 31) — main-процесс
- Целевая платформа: **Windows** (основная), macOS и Linux — best-effort
- tsconfig: references-схема (tsconfig.node.json + tsconfig.web.json), `strict` пока не включён — добавляем постепенно

## Аудио-формат — СВЯТОЕ

Все новые фичи аудио-стриминга **обязаны** поддерживать формат:

```
PCM 16000 Hz, 1 канал (моно), 16-bit (s16le)
Чанк: 6 секунд = 192 000 байт
```

- Если приходит другой sampleRate — `convertToTargetFormat()` делает ресэмплинг через линейную интерполяцию
- Если приходит стерео — миксдаун в моно
- Если приходит 32-bit float — конверсия в Int16
- **НЕ менять** `SAMPLE_RATE`, `CHANNELS`, `BITS_PER_SAMPLE` без согласования

## Стиль

- Отступы: 2 пробела
- Кавычки: одинарные (в TypeScript/React)
- Точка с запятой: да
- Имена файлов: camelCase для TypeScript (`audioCapture.ts`, `sttService.ts`), PascalCase для React-компонентов (`SuggestionPanel.tsx`)
- Имена переменных: camelCase
- Имена типов/интерфейсов: PascalCase
- Константы: UPPER_SNAKE_CASE для конфигурации (`SAMPLE_RATE`, `CHUNK_DURATION_MS`), camelCase для экземпляров
- Префикс `is`/`has`/`should` для boolean переменных (`isStreaming`, `isProcessing`)
- Алиасы путей: `@shared` → `src/shared`, `@renderer` → `src/renderer/src`
- Русские комментарии и лог-сообщения — это нормально, проект русскоязычный

## API

- Используем нативный `fetch()` (Node.js 18+ / Electron 31) — НЕ axios, НЕ node-fetch
- Whisper API: **всегда** оборачиваем PCM в WAV через `createWavBuffer()` перед отправкой
- Whisper API: **всегда** отправляем `language: "ru"` — без этого качество распознавания хуже
- OpenRouter API: **всегда** передаём `HTTP-Referer` и `X-Title` заголовки
- OpenRouter API: **всегда** используем `stream: true` — подсказки должны появляться в реальном времени
- Multipart формируем **вручную** через Buffer.concat — НЕ используем npm form-data
- STT-чанки отправляем **последовательно** (не параллельно) — для соблюдения rate limit
- При ошибке API — логируем и продолжаем, не крашим приложение

## IPC-мост

- **Единственный способ** передачи данных между main и renderer — IPC
- **НИКАКИХ удалённых вызовов**, только `ipcMain.handle` / `ipcRenderer.invoke` и `webContents.send`
- Новый IPC-канал → добавить имя в `src/shared/ipc.ts` → добавить тип payload → добавить в preload → обновить `CopilotApi` тип
- Renderer вызывает `window.copilot.*` — НЕ `ipcRenderer.*` напрямую
- Для микрофонных чанков: Renderer → `window.copilot.audio.sendMicChunk(ArrayBuffer)` → IPC `audio:sendMicChunk` → Main `handleMicChunkFromRenderer()`

## Overlay-окна — НЕ ЛОМАТЬ ТЮНИНГ

Окна оверлеев управляются через сложную комбинацию трюков:

1. **Прозрачность**: `backgroundColor: '#02000000'` (почти полностью прозрачный, но не `#00000000` — полностью прозрачный цвет не получает mouse-события на Windows)
2. **Click-through**: `setIgnoreMouseEvents(true, {forward: true})` — клики проходят сквозь окно
3. **Динамическое переключение**: mouseenter → `setIgnoreMouseEvents(false)` (окно становится кликабельным), mouseleave → `setIgnoreMouseEvents(true, {forward: true})` (клики проходят сквозь)
4. **Не крадут фокус**: `showInactive()` вместо `show()` для suggestion/transcript окон
5. **Always-on-top**: `alwaysOnTop: true` + `skipTaskbar: true`

**ПРАВИЛА**:
- НЕ менять `#02000000` на `#00000000` — сломается click-through на Windows
- НЕ вызывать `show()` вместо `showInactive()` для suggestion/transcript — они украдут фокус
- НЕ убирать `setIgnoreMouseEvents` — оверлей будет перехватывать все клики
- Управление прозрачностью — только через IPC `window:setTransparent` / `suggestion:setOpacity`

## Рендеринг

- Каждое overlay-окно — отдельный маршрут: `#/toolbar`, `#/suggestion`, `#/transcript`
- Стили внутри компонентов через `<style>{`...`}</style>` — пока нет CSS Modules
- CSS Variables определены в `theme.css` — использовать их, НЕ хардкодить цвета
- Glass-эффект: класс `.glass-panel` (backdrop-filter: blur(12px))
- Mono-текст: класс `.mono` (Consolas, Monaco)
- Кнопки: `.btn-primary` (фиолетовая), `.btn-ghost` (прозрачная)
- Scroll: класс `.scroll-y`

## Состояние

- **electron-store** — персистентные настройки (API ключи, модель, opacity, width)
- **React useState** — локальный UI-state в компонентах
- **Глобальные переменные в main-процессе** — состояние сервисов (`isStreaming`, `captureState`, `sttQueue`, `accumulatedTranscript`)
- **IPC** — единственный способ передачи данных между main и renderer

## Регистрация нового модуля

При добавлении нового модуля в main-процесс:

1. Создать файл в `src/main/services/` или `src/main/`
2. Экспортировать публичные функции
3. Добавить IPC-обработчики в `handlers.ts` (ipcMain.handle / ipcMain.on)
4. Добавить имя канала в `src/shared/ipc.ts` (объект IPC)
5. Добавить типы payload в `src/shared/ipc.ts`
6. Добавить метод в preload `src/preload/index.ts` (CopilotApi тип + реализация)
7. Обновить `03-modules.md` в банке памяти

## Принципы

1. **Простота > Количество зависимостей** — если можно сделать без npm-пакета, делаем без него
2. **Fallback всегда** — WASAPI не работает → ffmpeg. Groq недоступен → OpenAI. Network error → логируем, не крашим. Системный звук недоступен → работаем только с микрофоном.
3. **Overlay-этика** — окна всегда-on-top, но не крадут фокус (`showInactive`). Прозрачные области пропускают клики (`setIgnoreMouseEvents`).
4. **Последовательность > Параллельность** — для STT-очереди и API-вызовов. Проще, предсказуемее, меньше rate limit проблем.
5. **Русский язык в UI и логах** — продукт для русскоязычных 1С-разработчиков.
6. **6-секундные чанки** — золотой стандарт для Whisper. Не менять без веской причины.
7. **PCM 16kHz mono 16-bit** — единый формат для всего пайплайна. Всё остальное конвертируется.

## Критические API-ограничения

1. Whisper API НЕ принимает raw PCM — только WAV/MP3/M4A/WEBM
2. Groq rate limit: 30 запросов/мин на бесплатном плане
3. OpenRouter `data: [DONE]` — маркер конца SSE-стрима
4. SSE может разрезать JSON посередине — буферизировать строки
5. `win-audio-capture` работает ТОЛЬКО на Windows
6. ffmpeg fallback требует ffmpeg в PATH
7. Stereo Mix на Windows по умолчанию ОТКЛЮЧЕН — не полагаться на него
8. `getUserMedia` требует разрешения пользователя — первый вызов покажет диалог

## Критические уроки

1. **НЕ отправляй raw PCM на Whisper API** — всегда оборачивай в WAV. API вернёт ошибку формата.
2. **НЕ отправляй чанки STT параллельно** — исчерпаешь rate limit. Только последовательно.
3. **НЕ используй Web Audio API для системного звука** — браузер не даёт доступа к loopback. Только нативные модули.
4. **НЕ используй ffmpeg dshow для микрофона** — кириллические имена устройств ломают кодировку. Только getUserMedia.
5. **НЕ забывай `language: "ru"`** в запросе к Whisper — без этого качество распознавания русской речи катастрофически падает.
6. **НЕ парси SSE по строкам без буферизации** — JSON может быть разрезан посередине. Всегда `buffer = lines.pop()`.
7. **НЕ добавляй form-data npm-пакет** — ручная сборка через Buffer.concat надёжнее и без зависимостей.
8. **НЕ используй `response.body.getReader()` без проверки на null** — в некоторых версиях Node.js/Electron fetch может не поддерживать ReadableStream.
9. **НЕ забывай `HTTP-Referer` и `X-Title`** для OpenRouter — без них запрос может быть отклонён.
10. **НЕ ставь `captureState = true` до реальной проверки** что процесс захвата жив. spawn() — не гарантия работы.
11. **НЕ используй `#00000000` как backgroundColor** для overlay-окон — клики перестанут работать на Windows. Только `#02000000`.
