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

### 3. WASAPI loopback — МЁРТВЫЙ КОД (audioCapture.ts)

**Симптом**: Путь захвата через `win-audio-capture` никогда не выполнится. Переменная `nativeLoopback` инициализируется как `null`. Единственное место, где вызывается `loadNativeLoopback()` — внутри `startNativeLoopbackCapture()`. Но `startNativeLoopbackCapture()` вызывается только когда `process.platform === 'win32' && nativeLoopback` — то есть когда `nativeLoopback` уже truthy. Это chicken-and-egg: функция загрузки модуля вызывается только если модуль уже загружен.

**Почему критично**: Основной способ захвата системного звука на Windows — мёртвый код. Всегда используется ffmpeg fallback.

**Решение**: Вызывать `loadNativeLoopback()` в начале `startCapture('system')` ДО проверки `nativeLoopback`, или при инициализации модуля.

**Код-проблема (строка 345-351)**:
```typescript
if (source === 'system') {
    if (process.platform === 'win32' && nativeLoopback) {  // ← nativeLoopback всегда null!
      startNativeLoopbackCapture()  // ← никогда не вызовется
      ...
```

**Статус**: Открыто

---

### 4. `startCapture()` всегда возвращает `true`

**Симптом**: Функция `startCapture()` возвращает `true` даже если ffmpeg не удалось запустить. В `startFallbackCapture()` при ошибке `spawn` возвращается `null`, но в `startCapture()` результат `startFallbackCapture()` не проверяется.

**Почему критично**: UI показывает «захват запущен» даже если микрофон/динамик не захватываются. Пользователь думает, что приложение работает, но данных нет.

**Статус**: Открыто

---

### 5. ffmpeg child process не сохраняется — нельзя остановить

**Симптом**: В `startFallbackCapture()` создаётся child process `ffmpeg`, но ссылка на него НЕ сохраняется в переменной. Функция возвращает `interval ID` (health-check), но не сам process. При `stopCapture()` вызывается `clearInterval()`, но сам ffmpeg-процесс не убивается (`ffmpeg.kill()` не вызывается).

**Почему критично**: После нажатия «Стоп» ffmpeg продолжает работать в фоне, потребляя ресурсы и захватывая аудио. Zombie-процесс.

**Статус**: Открыто

---

### 6. `cleanup()` не вызывается при выходе приложения

**Симптом**: Функция `cleanup()` определена в handlers.ts (останавливает аудио-захват и стриминг), но НИГДЕ не зарегистрирована. В `index.ts` нет `app.on('before-quit', cleanup)` или `app.on('will-quit', cleanup)`.

**Почему критично**: При закрытии приложения ffmpeg-процессы и WASAPI-захват не останавливаются. Остаются zombie-процессы.

**Статус**: Открыто

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
- **ffmpeg health-check только логирует**: Не перезапускает процесс при падении.

### handlers.ts

- **4 IPC-хендлера используют хардкод-строки** вместо IPC-констант: `'suggestion:request'`, `'suggestion:abort'`, `'transcript:getCurrent'`, `'suggestion:isStreaming'`. Значения совпадают с ipc.ts, но если изменить константу — хендлер сломается молча.

### Renderer

- **SuggestionPanel не рендерит Markdown**: Показывает raw text с mono-шрифтом. Подсказки LLM в Markdown выглядят как `### Заголовок\n**жирный**\n- список`.
- **SettingsPanel: пошаговое сохранение**: Каждая настройка сохраняется отдельным `ipcRenderer.invoke()`. Если приложение упадёт между вызовами — часть настроек потеряется.

---

## Технический долг

1. **НЕТ ТЕСТОВ**: ни unit, ни integration. Весь код — untested.
2. **ПРОЕКТ НЕ СОБИРАЕТСЯ**: зависимости не установлены, конфиги отсутствуют.
3. **Нет логирования в файл**: только console.log.
4. **Нет упаковки**: нет electron-builder конфигурации.
5. **Стили inline**: CSS внутри компонентов через `<style>` тег. Нет CSS Modules.
6. **Нет TypeScript strict**: tsconfig не включает `strict: true`.
7. **Два package.json**: `src/package.json` и `pkg/package.json` — с разными зависимостями.
8. **Нет .env**: нет шаблона для API ключей разработки.
9. **Нет Markdown-рендеринга**: подсказки LLM отображаются как plain text.
10. **Нет hotkey**: нет глобальных горячих клавиш.
