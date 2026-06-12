/**
 * sttService.ts — Сервис транскрипции (Speech-to-Text) для 1C-Copilot
 *
 * Принимает аудио-чанки (16kHz Mono 16-bit PCM) от audioCapture,
 * отправляет их на Groq Whisper API или OpenAI Whisper API,
 * получает текст и транслирует его в renderer через IPC.
 *
 * Ключевые оптимизации:
 *   - Silence Gate: чанки с амплитудой < 1200/32768 отклоняются ДО отправки
 *     (отсекает аппаратные наводки и шум звуковой карты,
 *     предотвращает галлюцинации Whisper типа «Продолжение следует...»
 *     и экономит rate limit Groq)
 *   - Hallucination Filter: пост-фильтр текста ПОСЛЕ Whisper —
 *     отбрасывает типичные галлюцинации («Продолжение следует»,
 *     «Субтитры созданы сообществом» и пр.)
 *   - Rate limiting: 3с пауза между запросами + retry при 429
 *   - fetch через undici ProxyAgent (НЕ net.fetch — баг Electron #44249)
 */

import { BrowserWindow } from 'electron'
import { IPC, type TranscriptionUpdatePayload, type AppSettings } from '@shared/ipc'
import { getSetting } from '../store/settings'
import type { AudioSource } from './audioCapture'
import { fetchWithFallback } from './proxyFetch'

// ─── Конфигурация ────────────────────────────────────────────────────

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'
const WHISPER_MODEL_GROQ = 'whisper-large-v3'
const WHISPER_MODEL_OPENAI = 'whisper-1'

// Минимальный размер чанка для отправки (иначе Whisper может вернуть пустой результат)
const MIN_CHUNK_SIZE_BYTES = 32000 // ~1 сек при 16kHz 16-bit mono

// Silence Gate: порог амплитуды PCM Int16 (0-32768)
// Значение ниже → цифр тишина / аппаратный шум → не отправляем на API
// Увеличен с 400 до 1200 для отсечения наводок звуковой карты
const SILENCE_THRESHOLD = 1200 // ~3.7% от полной шкалы

// Rate limit: пауза между последовательными запросами (мс)
const REQUEST_DELAY_MS = 3000 // 3с → max 20 RPM (лимит Groq free)

// Retry при 429
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 4000 // 4с — Groq пишет "try again in 3s"

// Hallucination Filter: типичные галлюцинации Whisper на тишине/шуме
const HALLUCINATIONS = [
  'продолжение следует',
  'субтитры созданы сообществом',
  'спасибо за просмотр',
  'было бы неплохо',
  'конец фильма',
  'просмотр',
  'читайте на сайте'
]

// ─── Типы ────────────────────────────────────────────────────────────

export type SttProvider = 'groq' | 'openai'

export type SttResult = {
  text: string
  source: AudioSource
  confidence?: number
}

type SttQueueItem = {
  source: AudioSource
  chunk: Buffer
  sampleRate: number
  channels: number
}

// ─── Состояние ───────────────────────────────────────────────────────

let sttQueue: SttQueueItem[] = []
let isProcessing = false
let getWindow: (() => BrowserWindow | null) | null = null

// Накопленный текст созвона для контекста LLM
let accumulatedTranscript: string = ''
let lastTranscriptTime = 0

// Статистика silence gate
let silenceRejectedCount = 0

// ─── Вспомогательные функции ─────────────────────────────────────────

/** Пауза */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Проверяет PCM-буфер на цифровую тишину.
 * Анализирует амплитуду Int16 сэмплов: если максимальная
 * амплитуда ниже порога — это тишина (шум микрофона).
 * Предотвращает галлюцинации Whisper («Продолжение следует...»)
 * и экономит rate limit Groq.
 *
 * @returns true если чанк содержит речь, false если тишина
 */
function isNotSilence(pcmBuffer: Buffer): boolean {
  const int16Array = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  )

  let maxAmplitude = 0
  for (let i = 0; i < int16Array.length; i++) {
    const abs = Math.abs(int16Array[i])
    if (abs > maxAmplitude) maxAmplitude = abs
  }

  if (maxAmplitude < SILENCE_THRESHOLD) {
    silenceRejectedCount++
    if (silenceRejectedCount % 5 === 1) {
      // Логируем не каждый раз, чтобы не спамить (раз в 5 отверженных)
      console.log(`[sttService] Silence Gate: чанк отклонён (max amp: ${maxAmplitude}, порог: ${SILENCE_THRESHOLD}, всего отклонено: ${silenceRejectedCount})`)
    }
    return false
  }

  // Логируем прошедшие чанки для калибровки порога
  console.log(`[sttService] Silence Gate: чанк ПРОШЁЛ (max amp: ${maxAmplitude}, порог: ${SILENCE_THRESHOLD}) — отправляем на API`)
  return true
}

/**
 * Создаёт WAV-заголовок для PCM-данных.
 * Whisper API требует формат WAV (или mp3/m4a),
 * поэтому оборачиваем raw PCM в WAV.
 */
function createWavBuffer(pcmData: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2
  const blockAlign = channels * 2
  const dataSize = pcmData.length
  const headerSize = 44

  const wav = Buffer.alloc(headerSize + dataSize)

  // RIFF header
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)

  // fmt chunk
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)            // chunk size
  wav.writeUInt16LE(1, 20)             // PCM format
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(byteRate, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(16, 34)            // bits per sample

  // data chunk
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  pcmData.copy(wav, 44)

  return wav
}

/**
 * Отправляет аудио-чанк на Whisper API через Multipart Form Data.
 * С поддержкой retry при 429 (rate limit).
 *
 * ВАЖНО: используется fetchWithFallback (undici ProxyAgent),
 * а НЕ net.fetch. Причина: Electron bug #44249 —
 * net.fetch НЕ триггерит session.on('login') для прокси-авторизации,
 * туннель падает с ERR_TUNNEL_CONNECTION_FAILED.
 */
async function transcribeChunk(
  wavBuffer: Buffer,
  source: AudioSource
): Promise<SttResult | null> {
  const provider: SttProvider = getSetting('sttProvider')
  const apiKey: string = getSetting('sttApiKey')

  if (!apiKey) {
    console.warn('[sttService] API ключ не задан')
    return null
  }

  const url = provider === 'groq' ? GROQ_STT_URL : OPENAI_STT_URL
  const model = provider === 'groq' ? WHISPER_MODEL_GROQ : WHISPER_MODEL_OPENAI

  // Формируем multipart form data вручную (без внешних зависимостей)
  const boundary = `----FormBoundary${Date.now().toString(16)}`
  const filename = `chunk_${Date.now()}.wav`

  const parts: Buffer[] = []

  // Поле "file" — WAV-файл
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`
  parts.push(Buffer.from(fileHeader, 'utf-8'))
  parts.push(wavBuffer)
  parts.push(Buffer.from('\r\n', 'utf-8'))

  // Поле "model"
  const modelPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${model}\r\n`
  parts.push(Buffer.from(modelPart, 'utf-8'))

  // Поле "language"
  const langPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n` +
    `ru\r\n`
  parts.push(Buffer.from(langPart, 'utf-8'))

  // Поле "response_format"
  const formatPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `json\r\n`
  parts.push(Buffer.from(formatPart, 'utf-8'))

  // Закрытие boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))

  const body = Buffer.concat(parts)

  // ─── Retry loop для 429 ───
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // fetchWithFallback: через прокси (undici ProxyAgent),
      // если прокси недоступен — автоматически напрямую
      const response = await fetchWithFallback(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: new Uint8Array(body)
      })

      // 429 — rate limit: ждём и пробуем ещё
      if (response.status === 429 && attempt < MAX_RETRIES) {
        console.warn(`[sttService] Rate limit (429), retry ${attempt + 1}/${MAX_RETRIES} через ${RETRY_DELAY_MS}мс...`)
        await sleep(RETRY_DELAY_MS)
        continue
      }

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[sttService] API error ${response.status}:`, errorText)
        return null
      }

      const result = await response.json() as { text?: string }

      if (!result.text || result.text.trim().length === 0) {
        return null // Тишина или неразборчиво
      }

      // ─── Hallucination Filter: отбрасываем галлюцинации Whisper ───
      const recognizedText = result.text.trim()
      const cleanText = recognizedText.toLowerCase()
      const isHallucination =
        HALLUCINATIONS.some(phrase => cleanText.includes(phrase)) ||
        cleanText.length < 2

      if (isHallucination) {
        console.log(`[sttService] Текст отклонён фильтром галлюцинаций: "${recognizedText}"`)
        return null // Прерываем передачу мусора в UI и LLM
      }

      return {
        text: recognizedText,
        source
      }
    } catch (err) {
      console.error('[sttService] Ошибка транскрипции:', (err as Error).message)
      return null
    }
  }

  return null // Все попытки исчерпаны
}

// ─── Обработка очереди ───────────────────────────────────────────────

/**
 * Обрабатывает очередь аудио-чанков.
 * Отправляет чанки по одному с паузой REQUEST_DELAY_MS между запросами,
 * чтобы не превысить rate limit Groq (20 RPM).
 *
 * Silence Gate: чанки с амплитудой < порога отклоняются ДО конвертации в WAV,
 * что экономит rate limit и предотвращает галлюцинации Whisper.
 */
async function processQueue(): Promise<void> {
  if (isProcessing || sttQueue.length === 0) return

  isProcessing = true

  while (sttQueue.length > 0) {
    const item = sttQueue.shift()!
    const { source, chunk, sampleRate, channels } = item

    // Пропускаем слишком короткие чанки
    if (chunk.length < MIN_CHUNK_SIZE_BYTES) {
      continue
    }

    // ─── Silence Gate: отклоняем тишину ДО конвертации в WAV ───
    if (!isNotSilence(chunk)) {
      continue // Тишина — не отправляем на API
    }

    // Оборачиваем PCM в WAV (только для чанков с речью)
    const wavBuffer = createWavBuffer(chunk, sampleRate, channels)

    // Отправляем на транскрипцию
    const result = await transcribeChunk(wavBuffer, source)

    if (result && result.text) {
      // Отправляем в renderer через IPC
      const payload: TranscriptionUpdatePayload = {
        text: result.text,
        speaker: source === 'mic' ? 'mic' : 'system',
        isFinal: true,
        timestamp: Date.now()
      }

      broadcastTranscription(payload)

      // Накапливаем текст для контекста LLM
      const speakerLabel = source === 'mic' ? '[Микрофон]' : '[Собеседник]'
      accumulatedTranscript += `${speakerLabel}: ${result.text}\n`
      lastTranscriptTime = Date.now()
    }

    // ─── Rate limit: пауза между запросами ───
    if (sttQueue.length > 0) {
      await sleep(REQUEST_DELAY_MS)
    }
  }

  isProcessing = false
}

/**
 * Отправляет результат транскрипции во все окна renderer.
 */
function broadcastTranscription(payload: TranscriptionUpdatePayload): void {
  const allWindows = BrowserWindow.getAllWindows()
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC.transcription.update, payload)
    }
  }
}

// ─── Публичный API ───────────────────────────────────────────────────

export function initSttService(getWindowFn: () => BrowserWindow | null): void {
  getWindow = getWindowFn
  console.log('[sttService] Инициализирован (Silence Gate: порог < 1200/32768, Hallucination Filter: ON)')
}

export function enqueueChunk(
  source: AudioSource,
  chunk: Buffer,
  _sampleRate: number,
  _channels: number
): void {
  sttQueue.push({ source, chunk, sampleRate: _sampleRate, channels: _channels })
  void processQueue()
}

export function getAccumulatedTranscript(): string {
  return accumulatedTranscript
}

export function getLastTranscriptTime(): number {
  return lastTranscriptTime
}

export function clearTranscript(): void {
  accumulatedTranscript = ''
  lastTranscriptTime = 0
  sttQueue = []
  silenceRejectedCount = 0
}

export function getQueueLength(): number {
  return sttQueue.length
}
