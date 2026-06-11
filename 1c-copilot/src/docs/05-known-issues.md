# 05 — Известные проблемы и техдолг

## Критические проблемы (блокируют запуск)

### 1. Проект НЕ СОБИРАЕТСЯ — все зависимости UNMET

**Симптом**: `npm ls` показывает 12 UNMET DEPENDENCY. `electron-vite build` падает с `Cannot find package 'electron-vite'`. Нет `node_modules/`, нет `package-lock.json`.

**Почему критично**: Ни одна строка кода ни разу не была выполнена. Всё, что написано — теоретический код без практической проверки.

**Решение**: Выполнить `npm install`, затем исправить ошибки компиляции.

**Статус**: Открыто

---

### 2. Отсутствуют tsconfig.node.json и tsconfig.web.json

**Симптом**: `tsconfig.json` ссылается на `./tsconfig.node.json` и `./tsconfig.web.json`, но этих файлов не существует. TypeScript не сможет проверить типы.

**Почему критично**: Без этих файлов `tsc --noEmit` (и команда `typecheck` в package.json) не работает. Vite также может использовать их для конфигурации.

**Решение**: Создать `tsconfig.node.json` (для main + preload, Node.js окружение) и `tsconfig.web.json` (для renderer, браузерное окружение) по шаблону electron-vite.

**Статус**: Открыто

---

### 3. WASAPI loopback — МЁРТВЫЙ КОД (audioCapture.ts) → ✅ ИСПРАВЛЕНО (ЭТАП 2)

**Решение**: `loadNativeLoopback()` теперь вызывается в начале `startCapture('system')` ДО проверки `nativeLoopback`. Убрана избыточная загрузка внутри `startNativeLoopbackCapture()`.

**Статус**: Закрыто

---

### 4. `startCapture()` всегда возвращает `true` → ✅ ИСПРАВЛЕНО (ЭТАП 2)

**Решение**: `startFallbackCapture()` теперь возвращает `boolean`. В `startCapture()` результат проверяется: если ffmpeg не запустился — возвращается `false`.

**Статус**: Закрыто

---

### 5. ffmpeg child process не сохраняется — нельзя остановить → ✅ ИСПРАВЛЕНО (ЭТАП 2)

**Решение**: Ссылки на ffmpeg-процессы (`ffmpegMicProcess`, `ffmpegSystemProcess`) вынесены на уровень модуля. При `stopCapture()` вызывается `killFfmpegProcess()` с SIGKILL. При выходе приложения `cleanup()` → `stopAllCapture()` убивает все процессы.

**Статус**: Закрыто

---

### 6. `cleanup()` не вызывается при выходе приложения → ✅ ИСПРАВЛЕНО (ЭТАП 2)

**Решение**: В `index.ts` добавлен `app.on('before-quit', cleanup)`. При выходе приложения вызывается `cleanup()`, который останавливает все аудио-стримы и убивает ffmpeg-процессы.

**Статус**: Закрыто

---

## Проблемы конкретных модулей

### sttService.ts

- **Дублирование отправки**: `broadcastTranscription()` сначала отправляет через `getWindow()`, потом через `BrowserWindow.getAllWindows()`. Если getWindow() возвращает то же окно — сообщение дублируется.
- **fetch() с Buffer body**: Нативный `fetch()` в Node.js ожидает `ArrayBuffer`/`TypedArray`, а не `Buffer`. Может потребоваться `new Uint8Array(body)` или использование `Blob`.
- **Нет retry**: при ошибке сети или 429 от Groq чанк теряется навсегда.

### openrouterService.ts

- **suggestionHistory нарушает формат чата**: Хранятся только `assistant` сообщения, но OpenAI chat API требует чередование `user`/`assistant`. Если отправить `[system, assistant, assistant, user]` — API может вернуть ошибку.
- **Системный промпт зашит**: Нельзя изменить без пересборки.
- **temperature/max_tokens захардкожены**: Нельзя настроить через UI.

### audioCapture.ts

- **Захардкоженные имена аудио-устройств**: `"Stereo Mix (Realtek Audio)"`, `":BlackHole 2ch"`, `"audio=Microphone"` — на других машинах имена отличаются.
- **WASAPI sample rate 44100 захардкожен**: На некоторых системах 48000 или 96000.
- **Нет VAD**: Все чанки отправляются на STT, включая тишину.
- ~~ffmpeg health-check только логирует: Не перезапускает процесс при падении.~~ → удалено (процесс теперь убивается при ошибке, при необходимости перезапускается через UI)

### handlers.ts

- **4 IPC-хендлера используют хардкод-строки** вместо IPC-констант: `'suggestion:request'`, `'suggestion:abort'`, `'transcript:getCurrent'`, `'suggestion:isStreaming'`. Значения совпадают с ipc.ts, но если изменить константу — хендлер сломается молча.

### Renderer

- **SuggestionPanel не рендерит Markdown**: Показывает raw text с mono-шрифтом. Подсказки LLM в Markdown выглядят как `### Заголовок\n**жирный**\n- список`.
- **SettingsPanel: пошаговое сохранение**: Каждая настройка сохраняется отдельным `ipcRenderer.invoke()`. Если приложение упадёт между вызовами — часть настроек потеряется.

---

## Технический долг

1. **НЕТ ТЕСТОВ**: ни unit, ни integration. Весь код — untested.
2. ~~**ПРОЕКТ НЕ СОБИРАЕТСЯ**: зависимости не установлены, конфиги отсутствуют.~~ → ИСПРАВЛЕНО (ЭТАП 1)
3. **Нет логирования в файл**: только console.log.
4. **Нет упаковки**: нет electron-builder конфигурации.
5. **Стили inline**: CSS внутри компонентов через `<style>` тег. Нет CSS Modules.
6. **Нет TypeScript strict**: tsconfig не включает `strict: true`.
7. **Два package.json**: `src/package.json` и `pkg/package.json` — с разными зависимостями.
8. **Нет .env**: нет шаблона для API ключей разработки.
9. **Нет Markdown-рендеринга**: подсказки LLM отображаются как plain text.
10. **Нет hotkey**: нет глобальных горячих клавиш.
