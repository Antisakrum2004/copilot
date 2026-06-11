/**
 * audioCapture.ts — Сервис аудио-захвата для 1C-Copilot
 *
 * Захватывает два потока аудио:
 *   1. Системный звук (WASAPI loopback) — слышим собеседника
 *   2. Микрофон разработчика
 *
 * Нарезает поток на чанки по 5-7 секунд в формате:
 *   16 kHz, Mono, 16-bit PCM (Linear PCM, little-endian)
 *
 * Чанки отправляются через callback для дальнейшей
 * передачи в STT-сервис.
 */

import { BrowserWindow } from 'electron'
import { IPC, type AudioChunkPayload } from '@shared/ipc'
import type { ChildProcess } from 'child_process'

// ─── Конфигурация ────────────────────────────────────────────────────

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const CHUNK_DURATION_MS = 6000 // 6 секунд — оптимально для Whisper API
const CHUNK_SIZE_SAMPLES = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000 // 96 000 сэмплов
const CHUNK_SIZE_BYTES = CHUNK_SIZE_SAMPLES * (BITS_PER_SAMPLE / 8) // 192 000 байт

// ─── Типы ────────────────────────────────────────────────────────────

export type AudioSource = 'mic' | 'system'

export type AudioChunkCallback = (
  source: AudioSource,
  chunk: Buffer,
  sampleRate: number,
  channels: number
) => void

export type AudioCaptureState = {
  mic: boolean
  system: boolean
}

// ─── Внутреннее состояние ────────────────────────────────────────────

let captureState: AudioCaptureState = { mic: false, system: false }
let chunkCallback: AudioChunkCallback | null = null

// Нативный модуль WASAPI loopback (Windows-only)
let nativeLoopback: {
  start: (cb: (buffer: Buffer) => void) => void
  stop: () => void
} | null = null

// ffmpeg child processes — на уровне модуля для управления жизненным циклом
let ffmpegMicProcess: ChildProcess | null = null
let ffmpegSystemProcess: ChildProcess | null = null

// ─── Инициализация нативного модуля ──────────────────────────────────

function loadNativeLoopback(): void {
  if (process.platform !== 'win32') {
    console.warn('[audioCapture] WASAPI loopback доступен только на Windows')
    return
  }
  // Если уже загружен — не повторяем
  if (nativeLoopback) return

  try {
    // Пытаемся загрузить win-audio-capture (нативный модуль)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('win-audio-capture')
    nativeLoopback = {
      start: (cb: (buffer: Buffer) => void) => {
        mod.startCapture((buffer: Buffer) => {
          cb(buffer)
        })
      },
      stop: () => {
        mod.stopCapture()
      }
    }
    console.log('[audioCapture] Нативный WASAPI loopback загружен')
  } catch (err) {
    console.warn('[audioCapture] win-audio-capture не найден, используем fallback:', (err as Error).message)
    nativeLoopback = null
  }
}

// ─── Резэмплирование и конвертация ──────────────────────────────────

/**
 * Конвертирует аудио-буфер в формат 16kHz Mono 16-bit PCM.
 * Принимает входной буфер в любом формате и преобразует его.
 *
 * @param inputBuffer - Входной аудио-буфер (PCM, любой sample rate)
 * @param inputSampleRate - Частота дискретизации входного буфера
 * @param inputChannels - Количество каналов входного буфера
 * @returns Buffer в формате 16kHz Mono 16-bit PCM
 */
function convertToTargetFormat(
  inputBuffer: Buffer,
  inputSampleRate: number,
  inputChannels: number
): Buffer {
  const inputSamples = inputBuffer.length / (BITS_PER_SAMPLE / 8) / inputChannels
  const outputSamples = Math.round((inputSamples * SAMPLE_RATE) / inputSampleRate)
  const output = Buffer.alloc(outputSamples * 2) // 16-bit = 2 байта на сэмпл

  for (let i = 0; i < outputSamples; i++) {
    // Линейная интерполяция для резэмплирования
    const srcIndex = (i * inputSampleRate) / SAMPLE_RATE
    const srcIndexFloor = Math.floor(srcIndex)
    const frac = srcIndex - srcIndexFloor

    // Миксуем каналы в моно (берём среднее)
    let monoSample: number
    if (inputChannels === 1) {
      const offset = srcIndexFloor * 2
      monoSample = offset + 1 < inputBuffer.length
        ? inputBuffer.readInt16LE(offset)
        : 0
    } else {
      let sum = 0
      for (let ch = 0; ch < inputChannels; ch++) {
        const offset = (srcIndexFloor * inputChannels + ch) * 2
        if (offset + 1 < inputBuffer.length) {
          sum += inputBuffer.readInt16LE(offset)
        }
      }
      monoSample = Math.round(sum / inputChannels)
    }

    // Интерполяция между соседними сэмплами
    if (srcIndexFloor + 1 < inputSamples && frac > 0) {
      let nextMonoSample: number
      if (inputChannels === 1) {
        const offset = (srcIndexFloor + 1) * 2
        nextMonoSample = offset + 1 < inputBuffer.length
          ? inputBuffer.readInt16LE(offset)
          : 0
      } else {
        let sum = 0
        for (let ch = 0; ch < inputChannels; ch++) {
          const offset = ((srcIndexFloor + 1) * inputChannels + ch) * 2
          if (offset + 1 < inputBuffer.length) {
            sum += inputBuffer.readInt16LE(offset)
          }
        }
        nextMonoSample = Math.round(sum / inputChannels)
      }
      monoSample = Math.round(monoSample * (1 - frac) + nextMonoSample * frac)
    }

    // Clamp to 16-bit range
    monoSample = Math.max(-32768, Math.min(32767, monoSample))
    output.writeInt16LE(monoSample, i * 2)
  }

  return output
}

// ─── Буферизация чанков ──────────────────────────────────────────────

/**
 * Накапливает аудио-данные и вызывает callback
 * когда накоплен чанк нужного размера (CHUNK_DURATION_MS).
 */
class ChunkBuffer {
  private buffer = Buffer.alloc(0)
  private source: AudioSource
  private inputSampleRate: number
  private inputChannels: number

  constructor(source: AudioSource, inputSampleRate: number, inputChannels: number) {
    this.source = source
    this.inputSampleRate = inputSampleRate
    this.inputChannels = inputChannels
  }

  /** Добавить аудио-данные в буфер */
  push(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])

    // Проверяем, накоплен ли чанк нужного размера
    while (this.buffer.length >= CHUNK_SIZE_BYTES) {
      const chunk = this.buffer.subarray(0, CHUNK_SIZE_BYTES)
      this.buffer = this.buffer.subarray(CHUNK_SIZE_BYTES)

      // Конвертируем в целевой формат
      const converted = convertToTargetFormat(chunk, this.inputSampleRate, this.inputChannels)

      if (chunkCallback) {
        chunkCallback(this.source, converted, SAMPLE_RATE, CHANNELS)
      }
    }
  }

  /** Сбросить буфер */
  reset(): void {
    this.buffer = Buffer.alloc(0)
  }

  /** Оставшиеся данные (flush) */
  flush(): void {
    if (this.buffer.length > 0 && chunkCallback) {
      const converted = convertToTargetFormat(
        this.buffer,
        this.inputSampleRate,
        this.inputChannels
      )
      chunkCallback(this.source, converted, SAMPLE_RATE, CHANNELS)
    }
    this.buffer = Buffer.alloc(0)
  }
}

// ─── Fallback-захват через ffmpeg ────────────────────────────────────

/**
 * Fallback-режим захвата аудио через child_process + ffmpeg.
 * Работает на любой платформе где установлен ffmpeg.
 *
 * Ссылка на процесс сохраняется на уровне модуля
 * (ffmpegMicProcess / ffmpegSystemProcess) для корректного
 * завершения через stopCapture().
 *
 * @returns true если процесс ffmpeg успешно запущен, false если нет
 */
function startFallbackCapture(
  source: AudioSource,
  chunkBuf: ChunkBuffer
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process')

  let ffmpegArgs: string[]

  if (source === 'system' && process.platform === 'win32') {
    // Windows: захват системного звука через dshow (Stereo Mix)
    ffmpegArgs = [
      '-f', 'dshow',
      '-i', 'audio=Stereo Mix (Realtek Audio)',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  } else if (source === 'system' && process.platform === 'darwin') {
    // macOS — захват через BlackHole/Soundflower
    ffmpegArgs = [
      '-f', 'avfoundation',
      '-i', ':BlackHole 2ch',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  } else if (source === 'mic') {
    // Микрофон — через платформенный захватчик
    const deviceFormat = process.platform === 'win32' ? 'dshow' :
      process.platform === 'darwin' ? 'avfoundation' : 'alsa'
    const deviceName = process.platform === 'win32' ? 'audio=Microphone' :
      process.platform === 'darwin' ? ':Built-in Microphone' : 'default'
    ffmpegArgs = [
      '-f', deviceFormat,
      '-i', deviceName,
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  } else {
    // Linux ALSA — системный звук
    ffmpegArgs = [
      '-f', 'alsa',
      '-i', 'default',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  }

  try {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'ignore'] })

    // Сохраняем ссылку на процесс на уровне модуля
    if (source === 'system') {
      ffmpegSystemProcess = ffmpeg
    } else {
      ffmpegMicProcess = ffmpeg
    }

    // Флаг успешного старта: ffmpeg считается запущенным,
    // если не упал в первые 2 секунды или если пришли первые данные
    let startupConfirmed = false
    const startupTimer = setTimeout(() => {
      if (!startupConfirmed) {
        startupConfirmed = true
        console.log(`[audioCapture] ffmpeg (${source}) стартовал успешно (grace period)`)
      }
    }, 2000)

    ffmpeg.stdout?.on('data', (data: Buffer) => {
      // Первые данные = процесс работает, подтверждаем старт
      if (!startupConfirmed) {
        startupConfirmed = true
        clearTimeout(startupTimer)
      }
      chunkBuf.push(data)
    })

    ffmpeg.on('error', (err: Error) => {
      console.error(`[audioCapture] ffmpeg error (${source}):`, err.message)
      clearTimeout(startupTimer)
      // Очищаем ссылку на упавший процесс
      if (source === 'system') {
        ffmpegSystemProcess = null
      } else {
        ffmpegMicProcess = null
      }
    })

    ffmpeg.on('close', (code: number) => {
      console.log(`[audioCapture] ffmpeg exited (${source}) with code ${code}`)
      clearTimeout(startupTimer)
      // Очищаем ссылку на завершённый процесс
      if (source === 'system') {
        ffmpegSystemProcess = null
      } else {
        ffmpegMicProcess = null
      }
    })

    return true
  } catch (err) {
    console.error(`[audioCapture] Не удалось запустить ffmpeg (${source}):`, (err as Error).message)
    return false
  }
}

/**
 * Безопасно убивает процесс ffmpeg по ссылке.
 * Сначала SIGKILL, на Windows — fallback на kill() без сигнала.
 */
function killFfmpegProcess(proc: ChildProcess | null, source: AudioSource): void {
  if (!proc) return
  if (proc.killed || proc.exitCode !== null) return

  try {
    proc.kill('SIGKILL')
    console.log(`[audioCapture] ffmpeg (${source}) убит (SIGKILL)`)
  } catch {
    // На Windows SIGKILL может не поддерживаться
    try {
      proc.kill()
      console.log(`[audioCapture] ffmpeg (${source}) убит (default signal)`)
    } catch (e) {
      console.warn(`[audioCapture] Не удалось убить ffmpeg (${source}):`, (e as Error).message)
    }
  }
}

// ─── Нативный WASAPI loopback ────────────────────────────────────────

let systemChunkBuf: ChunkBuffer | null = null
let micChunkBuf: ChunkBuffer | null = null

function startNativeLoopbackCapture(): void {
  if (!nativeLoopback) {
    console.warn('[audioCapture] Нативный loopback недоступен, fallback через ffmpeg')
    return
  }
  // WASAPI обычно отдаёт 44.1kHz стерео
  systemChunkBuf = new ChunkBuffer('system', 44100, 2)
  nativeLoopback.start((buffer: Buffer) => {
    systemChunkBuf?.push(buffer)
  })
}

function stopNativeLoopbackCapture(): void {
  if (nativeLoopback) {
    nativeLoopback.stop()
  }
  systemChunkBuf?.flush()
  systemChunkBuf = null
}

// ─── Публичный API ───────────────────────────────────────────────────

export function setChunkCallback(cb: AudioChunkCallback): void {
  chunkCallback = cb
}

export function startCapture(source: AudioSource): boolean {
  if (captureState[source]) {
    console.warn(`[audioCapture] ${source} уже захватывается`)
    return true
  }

  if (source === 'system') {
    // ─── ИСПРАВЛЕНО (WASAPI Dead Code): Загружаем нативный модуль
    // ДО проверки nativeLoopback. Раньше loadNativeLoopback()
    // никогда не вызывался перед ветвлением, и nativeLoopback
    // всегда был null → WASAPI путь был мёртвым кодом.
    loadNativeLoopback()

    if (process.platform === 'win32' && nativeLoopback) {
      startNativeLoopbackCapture()
      captureState.system = true
      console.log('[audioCapture] Системный звук: WASAPI loopback запущен')
      return true
    }

    // Fallback через ffmpeg
    systemChunkBuf = new ChunkBuffer('system', SAMPLE_RATE, CHANNELS)
    const ffmpegOk = startFallbackCapture('system', systemChunkBuf)
    if (!ffmpegOk) {
      console.error('[audioCapture] Системный звук: ffmpeg fallback не запустился')
      return false
    }
    captureState.system = true
    console.log('[audioCapture] Системный звук: ffmpeg fallback запущен')
    return true
  }

  // Микрофон
  micChunkBuf = new ChunkBuffer('mic', SAMPLE_RATE, CHANNELS)
  const micOk = startFallbackCapture('mic', micChunkBuf)
  if (!micOk) {
    console.error('[audioCapture] Микрофон: ffmpeg не запустился')
    return false
  }
  captureState.mic = true
  console.log('[audioCapture] Микрофон: захват запущен')
  return true
}

export function stopCapture(source: AudioSource): void {
  if (!captureState[source]) return

  if (source === 'system') {
    stopNativeLoopbackCapture()
    // ─── ИСПРАВЛЕНО (Zombie): Убиваем ffmpeg-процесс системного звука
    killFfmpegProcess(ffmpegSystemProcess, 'system')
    ffmpegSystemProcess = null
    systemChunkBuf?.flush()
    systemChunkBuf = null
    captureState.system = false
    console.log('[audioCapture] Системный звук: остановлен')
  } else {
    // ─── ИСПРАВЛЕНО (Zombie): Убиваем ffmpeg-процесс микрофона
    killFfmpegProcess(ffmpegMicProcess, 'mic')
    ffmpegMicProcess = null
    micChunkBuf?.flush()
    micChunkBuf = null
    captureState.mic = false
    console.log('[audioCapture] Микрофон: остановлен')
  }
}

export function stopAllCapture(): void {
  stopCapture('mic')
  stopCapture('system')
}

export function getCaptureState(): AudioCaptureState {
  return { ...captureState }
}

/**
 * Создаёт callback, который отправляет аудио-чанки
 * в renderer-процесс через IPC.
 */
export function createIpcChunkSender(
  getWindow: () => BrowserWindow | null
): AudioChunkCallback {
  return (source, chunk, sampleRate, channels) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const payload: AudioChunkPayload = {
      data: chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength
      ) as ArrayBuffer,
      sampleRate,
      channels
    }

    const channel = source === 'mic' ? IPC.audio.micChunk : IPC.audio.speakerChunk
    win.webContents.send(channel, payload)
  }
}
