# 02 — Ловушки внешних API

## ГЛАВНАЯ ЛОВУШКА

**Whisper API не принимает raw PCM.** Нужно обязательно оборачивать PCM-данные в WAV-заголовок (44 байта). Без этого API возвращает ошибку формата. В sttService.ts реализована функция `createWavBuffer()`, которая добавляет RIFF/WAVE заголовок к PCM-данным.

## Groq Whisper API

### Endpoint
`POST https://api.groq.com/openai/v1/audio/transcriptions`

### Аутентификация
```
Authorization: Bearer gsk_XXXXXXXXXXXXXXXXXXXXXXXX
```
Ключ начинается с `gsk_`. Получить: https://console.groq.com/keys

### Тело запроса (multipart/form-data)
```
--boundary
Content-Disposition: form-data; name="file"; filename="chunk_1234567890.wav"
Content-Type: audio/wav

<WAV-данные>
--boundary
Content-Disposition: form-data; name="model"

whisper-large-v3
--boundary
Content-Disposition: form-data; name="language"

ru
--boundary
Content-Disposition: form-data; name="response_format"

json
--boundary--
```

### Формат ответа
```json
{
  "text": "распознанный текст на русском"
}
```

### Ловушки Groq

1. **Rate limit**: 30 запросов/мин на бесплатном плане. При 6-секундных чанках и двух потоках (mic + system) = до 20 запросов/мин — в пределах лимита, но впритык.
2. **Размер файла**: максимум 25 МБ. 6-секундный чанк при 16kHz 16-bit mono = ~192KB — далеко от лимита.
3. **Формат файла**: принимает WAV, MP3, M4A, WEBM. Не принимает raw PCM!
4. **Пустой ответ**: если в аудио тишина или неразборчивая речь, `text` может быть пустой строкой или отсутствовать. Код проверяет `result.text?.trim().length === 0`.
5. **language**: параметр необязательный, но без него качество распознавания русской речи хуже. Жёстко зашит `"ru"`.
6. **Модель**: `whisper-large-v3` — самая точная. `whisper-large-v3-turbo` — быстрее, но чуть хуже. `distil-whisper-large-v3-en` — ТОЛЬКО английский, НЕ использовать!
7. **Multipart без библиотек**: код формирует multipart вручную через Buffer.concat — без form-data/npm зависимости. Это работает, но нужно точно соблюдать `\r\n` разделители и boundary-формат.

### Минимальный размер чанка

Whisper плохо распознаёт очень короткие фрагменты. В коде стоит `MIN_CHUNK_SIZE_BYTES = 32000` (~1 сек при 16kHz 16-bit). Чанки короче этого пропускаются.

---

## OpenAI Whisper API

### Endpoint
`POST https://api.openai.com/v1/audio/transcriptions`

### Аутентификация
```
Authorization: Bearer sk-XXXXXXXXXXXXXXXXXXXXXXXX
```
Ключ начинается с `sk-`. Получить: https://platform.openai.com/api-keys

### Тело запроса
Аналогично Groq, но модель: `whisper-1`

### Ловушки OpenAI

1. **Платный**: $0.006/мин audio. При постоянном использовании дорого.
2. **Медленнее Groq**: Groq использует LPU-инфраструктуру, OpenAI — GPU. Разница в 3-5x.
3. **Тот же формат**: multipart/form-data, WAV, те же поля.
4. **Та же модель**: под капотом OpenAI тоже использует Whisper large-v3, но называют `whisper-1`.

---

## OpenRouter API

### Endpoint
`POST https://openrouter.ai/api/v1/chat/completions`

### Аутентификация
```
Authorization: Bearer sk-or-v1-XXXXXXXXXXXXXXXXXXXXXXXX
Content-Type: application/json
HTTP-Referer: https://1c-copilot.app
X-Title: 1C-Copilot
```
Ключ начинается с `sk-or-v1-`. Получить: https://openrouter.ai/keys

### Тело запроса
```json
{
  "model": "qwen/qwen-2.5-coder-32b-instruct",
  "messages": [
    {"role": "system", "content": "...системный промпт 1С..."},
    {"role": "user", "content": "Вот живой текст текущего созвона:\n\n...\n\nДай краткую техническую подсказку по 1С..."}
  ],
  "stream": true,
  "max_tokens": 1024,
  "temperature": 0.4
}
```

### Формат SSE-ответа (streaming)
```
data: {"choices":[{"delta":{"content":"### "}}]}

data: {"choices":[{"delta":{"content":"Подсказка"}}]}

data: {"choices":[{"delta":{"content":" по 1С"}}]}

data: [DONE]
```

### Ловушки OpenRouter

1. **HTTP-Referer и X-Title**: не обязательны, но OpenRouter может отклонить запрос без них. В коде зашиты `https://1c-copilot.app` и `1C-Copilot`.
2. **stream: true**: возвращает SSE (Server-Sent Events). Каждая строка начинается с `data: `. Строка `data: [DONE]` — конец стрима.
3. **delta.content**: токены приходят в `choices[0].delta.content`. В последнем сообщении перед `[DONE]` может не быть `content` — нужно проверять.
4. **Неполные JSON**: SSE может разрезать JSON посередине между чанками. Код использует буфер `lines` и `lines.pop()` для обработки неполных строк.
5. **Модели**: `qwen/qwen-2.5-coder-32b-instruct` — хороша для кода, но иногда галлюцинирует. `anthropic/claude-3.5-sonnet` — точнее, но дороже и медленнее.
6. **Rate limit**: зависит от кредитов на аккаунте. Бесплатные модели — очень медленные.
7. **max_tokens: 1024**: ограничение длины подсказки. Для кратких 1С-подсказок этого хватает. Если подсказка обрезается — увеличить.
8. **temperature: 0.4**: низкая температура для детерминированных технических подсказок. Выше 0.7 — начинает «фантазировать».
9. **История**: хранятся последние 3 подсказки (suggestionHistory) для контекста. Добавляются в messages перед текущим user-сообщением.

### Автоматическая отправка

`triggerAutoSuggestion()` вызывается из audioCapture callback при каждом чанке системного звука. Ставит таймер на 2с (`MIN_SILENCE_BEFORE_LLM`). Если за 2с пришёл новый чанк — таймер сбрасывается. Таким образом запрос уходит только после паузы в разговоре собеседника.

### Обрезка контекста

`trimContext()` обрезает накопленный текст до последних 12000 символов (`MAX_CONTEXT_CHARS`). Добавляет `...\n` в начало как индикатор обрезки.

---

## Форматы данных

| Данные | Формат | Где |
|--------|--------|-----|
| Аудио чанк (внутренний) | 16kHz Mono 16-bit PCM LE, Buffer | audioCapture → sttService |
| Аудио чанк (API) | WAV (PCM + 44-байт заголовок) | sttService → Whisper API |
| STT результат | JSON `{text: string}` | Whisper API → sttService |
| IPC транскрипция | `{text, speaker, isFinal, timestamp}` | sttService → renderer |
| IPC подсказка | `{content, streaming}` | openrouterService → renderer |
| Настройки | JSON (electron-store) | settings.ts ↔ disk |
| LLM запрос | JSON OpenAI-compatible | openrouterService → OpenRouter |
| LLM ответ | SSE (text/event-stream) | OpenRouter → openrouterService |

## Пагинация

Whisper API и OpenRouter API не используют пагинацию — это запрос-ответные API. STT отправляет чанки последовательно (не параллельно), чтобы не превысить rate limit Groq.

## Исключения

1. **Linux системный звук**: ffmpeg fallback использует `alsa default`, что может захватить микрофон вместо системного звука. Нужен PulseAudio loopback.
2. **macOS системный звук**: требуется виртуальный аудио-драйвер (BlackHole / Soundflower). Без него ffmpeg fallback не захватит системный звук.
3. **whisper-large-v3-turbo**: не поддерживает русский язык так же хорошо как whisper-large-v3.

## Вебхуки/токены

Проект не использует вебхуки. Все API-вызовы — исходящие (pull). Токены хранятся в electron-store:
- `openRouterApiKey` — ключ OpenRouter
- `sttApiKey` — ключ Groq или OpenAI
- `sttProvider` — выбор провайдера (`"groq"` или `"openai"`)

## Хранилище

electron-store сохраняет JSON-файл `settings.json` в директории `userData` Electron:
- Windows: `%APPDATA%/1c-copilot/settings.json`
- macOS: `~/Library/Application Support/1c-copilot/settings.json`
- Linux: `~/.config/1c-copilot/settings.json`
