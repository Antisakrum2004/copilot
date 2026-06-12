/**
 * sttService.ts — Сервис транскрипции (Speech-to-Text) для 1C-Copilot
 *
 * Принимает аудио-чанки (16kHz Mono 16-bit PCM) от audioCapture,
 * отправляет их на Groq Whisper API или OpenAI Whisper API,
 * получает текст и транслирует его в renderer через IPC.
 *
 * Поддержка:
 *   - Groq (whisper-large-v3) — быстрый, бесплатно до лимитов
 *   - OpenAI (whisper-1) — стандартный, платный
 *
 * Rate limiting: Groq free tier = 20 RPM.
 * С 6-секундными чанками и 2 потоками (mic+system) = ~20 RPM.
 * Добавлена пауза 3с между запросами + retry при 429.
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

// Rate limit: пауза между последовательными запросами (мс)
const REQUEST_DELAY_MS = 3000 // 3с → max 20 RPM (лимит Groq free)

// Retry при 429
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 4000 // 4с — Groq пишет "try again in 3s"

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

// ─── Вспомогательные функции ─────────────────────────────────────────

/** Пауза */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

      return {
        text: result.text.trim(),
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
 */
async function processQueue(): Promise<void> {
  if (isProcessing || sttQueue.length === 0) return

  isProcessing = true

  while (sttQueue.length > 0) {
    const item = sttQueue.shift()!
    const { source, chunk, sampleRate, channels } = item

    // Пропускаем слишком короткие чанки (тишина)
    if (chunk.length < MIN_CHUNK_SIZE_BYTES) {
      continue
    }

    // Оборачиваем PCM в WAV
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
    // Groq free = 20 RPM → 3с между запросами
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
  if (!getWindow) return
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.transcription.update, payload)
  }

  // Также транслируем во все окна (toolbar, suggestion, transcript)
  const allWindows = BrowserWindow.getAllWindows()
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC.transcription.update, payload)
    }
  }
}

// ─── Публичный API ───────────────────────────────────────────────────

/**
 * Инициализировать STT-сервис.
 * @param getWindowFn — функция, возвращающая главное окно приложения
 */
export function initSttService(getWindowFn: () => BrowserWindow | null): void {
  getWindow = getWindowFn
  console.log('[sttService] Инициализирован')
}

/**
 * Добавить аудио-чанк в очередь на транскрипцию.
 * Вызывается из audioCapture при накоплении чанка.
 */
export function enqueueChunk(
  source: AudioSource,
  chunk: Buffer,
  _sampleRate: number,
  _channels: number
): void {
  sttQueue.push({ source, chunk, sampleRate: _sampleRate, channels: _channels })

  // Запускаем обработку очереди (асинхронно, без await)
  void processQueue()
}

/**
 * Получить накопленный текст созвона.
 * Используется OpenRouter-сервисом для контекста.
 */
export function getAccumulatedTranscript(): string {
  return accumulatedTranscript
}

/**
 * Получить время последней транскрипции.
 */
export function getLastTranscriptTime(): number {
  return lastTranscriptTime
}

/**
 * Сбросить накопленную транскрипцию.
 */
export function clearTranscript(): void {
  accumulatedTranscript = ''
  lastTranscriptTime = 0
  sttQueue = []
}

/**
 * Получить длину очереди (для диагностики).
 */
export function getQueueLength(): number {
  return sttQueue.length
}
