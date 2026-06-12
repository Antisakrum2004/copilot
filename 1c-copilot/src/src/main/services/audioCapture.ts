/**
 * audioCapture.ts — Сервис аудио-захвата для 1C-Copilot
 *
 * АРХИТЕКТУРА (v2):
 *
 * Микрофон — захватывается в Renderer-процессе через
 * navigator.mediaDevices.getUserMedia(). Renderer создаёт
 * AudioContext на 16kHz, 1 канал, получает Float32 через
 * ScriptProcessorNode, конвертирует в Int16 PCM и шлёт
 * чанки через IPC (audio:sendMicChunk). Main-процесс
 * принимает чанки и кормит их в ChunkBuffer → pipeline.
 *
 * Системный звук — захватывается в Main-процессе через
 * WASAPI loopback (win-audio-capture) или ffmpeg fallback.
 * Все ошибки обёрнуты в try/catch, чтобы не ронять процесс.
 *
 * Чанки нарезаются по 6 секунд: 16kHz, Mono, 16-bit PCM.
 */

import { BrowserWindow } from 'electron'
import { IPC, type AudioChunkPayload } from '@shared/ipc'
import type { ChildProcess } from 'child_process'

// ─── Конфигурация ────────────────────────────────────────────────────

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const CHUNK_DURATION_MS = 6000
const CHUNK_SIZE_SAMPLES = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000
const CHUNK_SIZE_BYTES = CHUNK_SIZE_SAMPLES * (BITS_PER_SAMPLE / 8) // 192 000

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

// ffmpeg child process для системного звука
let ffmpegSystemProcess: ChildProcess | null = null

// ─── Резэмплирование и конвертация ──────────────────────────────────

function convertToTargetFormat(
  inputBuffer: Buffer,
  inputSampleRate: number,
  inputChannels: number
): Buffer {
  const inputSamples = inputBuffer.length / (BITS_PER_SAMPLE / 8) / inputChannels
  const outputSamples = Math.round((inputSamples * SAMPLE_RATE) / inputSampleRate)
  const output = Buffer.alloc(outputSamples * 2)

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = (i * inputSampleRate) / SAMPLE_RATE
    const srcIndexFloor = Math.floor(srcIndex)
    const frac = srcIndex - srcIndexFloor

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

    monoSample = Math.max(-32768, Math.min(32767, monoSample))
    output.writeInt16LE(monoSample, i * 2)
  }

  return output
}

// ─── Буферизация чанков ──────────────────────────────────────────────

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

  push(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])

    while (this.buffer.length >= CHUNK_SIZE_BYTES) {
      const chunk = this.buffer.subarray(0, CHUNK_SIZE_BYTES)
      this.buffer = this.buffer.subarray(CHUNK_SIZE_BYTES)

      const converted = convertToTargetFormat(chunk, this.inputSampleRate, this.inputChannels)

      if (chunkCallback) {
        chunkCallback(this.source, converted, SAMPLE_RATE, CHANNELS)
      }
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }

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

// ─── Буферы ──────────────────────────────────────────────────────────

let systemChunkBuf: ChunkBuffer | null = null
let micChunkBuf: ChunkBuffer | null = null

// ─── WASAPI loopback (системный звук, Windows-only) ──────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nativeCaptureInstance: any = null
let nativeLoadFailed = false
let nativeCaptureActive = false

/**
 * Загружает win-audio-capture — JavaScript-обёртку над ffmpeg.
 * Экспортирует КЛАСС WinAudioCapture.
 */
function loadNativeLoopback(): void {
  if (process.platform !== 'win32') {
    console.warn('[audioCapture] WASAPI loopback доступен только на Windows')
    return
  }
  if (nativeLoadFailed || nativeCaptureInstance) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('win-audio-capture')
    const WinAudioCapture = mod.WinAudioCapture || mod.default
    if (!WinAudioCapture || typeof WinAudioCapture !== 'function') {
      console.error('[audioCapture] WinAudioCapture класс НЕ найден в экспорте')
      nativeLoadFailed = true
      return
    }
    nativeCaptureInstance = new WinAudioCapture()

    const requiredMethods = ['getDevices', 'startCapture', 'stopCapture', 'getRecommendedDevice']
    for (const method of requiredMethods) {
      if (typeof nativeCaptureInstance[method] !== 'function') {
        console.error(`[audioCapture] WinAudioCapture.${method} — НЕ функция`)
        nativeLoadFailed = true
        nativeCaptureInstance = null
        return
      }
    }
    console.log('[audioCapture] ✅ WinAudioCapture загружен')
  } catch (err) {
    console.error('[audioCapture] ❌ Ошибка загрузки win-audio-capture:', (err as Error).message)
    nativeLoadFailed = true
    nativeCaptureInstance = null
  }
}

/**
 * Запускает захват системного звука через WinAudioCapture.
 * Обёрнуто в try/catch — ошибки НЕ роняют процесс.
 */
async function startNativeLoopbackCapture(): Promise<boolean> {
  if (!nativeCaptureInstance) return false
  if (nativeCaptureActive) {
    console.warn('[audioCapture] Loopback уже запущен')
    return true
  }

  try {
    const devices = await nativeCaptureInstance.getDevices()
    let selectedDevice = nativeCaptureInstance.getRecommendedDevice(devices)

    if (!selectedDevice) {
      const stereoMix = devices.find((d: { deviceType?: string; name?: string }) =>
        d.deviceType === 'stereo_mix' ||
        (d.name && d.name.toLowerCase().includes('stereo mix'))
      )
      if (stereoMix) {
        selectedDevice = stereoMix
      } else if (devices.length > 0) {
        console.warn('[audioCapture] Stereo Mix не найден, пробуем первое устройство:', devices[0].name)
        selectedDevice = devices[0]
      }
    }

    if (!selectedDevice) {
      console.error('[audioCapture] ❌ Нет аудио-устройств для системного захвата')
      nativeLoadFailed = true
      return false
    }

    console.log(`[audioCapture] Выбрано устройство: "${selectedDevice.name}"`)
    systemChunkBuf = new ChunkBuffer('system', 44100, 2)
    let wavHeaderSkipped = false

    await nativeCaptureInstance.startCapture({
      device: selectedDevice.name,
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      onData: (chunk: Buffer) => {
        if (!chunk || chunk.length === 0) return
        let data = chunk
        if (!wavHeaderSkipped) {
          if (chunk.length > 44) {
            data = chunk.subarray(44)
            wavHeaderSkipped = true
          } else {
            return
          }
        }
        systemChunkBuf?.push(data)
      }
    })

    nativeCaptureActive = true
    console.log(`[audioCapture] ✅ Системный звук: WinAudioCapture запущен`)
    return true
  } catch (err) {
    const error = err as Error
    console.error('[audioCapture] ❌ WinAudioCapture.startCapture():', error.message)

    // Если "already running" — захват УЖЕ работает, это не сбой
    if (error.message && error.message.toLowerCase().includes('already running')) {
      console.log('[audioCapture] ✅ Захват уже запущен (already running)')
      nativeCaptureActive = true
      return true
    }

    nativeLoadFailed = true
    nativeCaptureActive = false
    console.warn('[audioCapture] → Переключаемся на ffmpeg fallback')
    return false
  }
}

function stopNativeLoopbackCapture(): void {
  try {
    if (nativeCaptureInstance && nativeCaptureActive) {
      void nativeCaptureInstance.stopCapture()
    }
  } catch (err) {
    console.warn('[audioCapture] Ошибка stopCapture():', (err as Error).message)
  }
  nativeCaptureActive = false
  systemChunkBuf?.flush()
  systemChunkBuf = null
}

// ─── FFmpeg fallback (только системный звук!) ────────────────────────

/**
 * Запускает ffmpeg для захвата системного звука.
 * Обёрнуто в try/catch — ошибки НЕ роняют процесс.
 */
function startFfmpegSystemCapture(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process')

  let ffmpegArgs: string[]

  if (process.platform === 'win32') {
    ffmpegArgs = [
      '-f', 'dshow',
      '-i', 'audio=Stereo Mix (Realtek Audio)',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  } else if (process.platform === 'darwin') {
    ffmpegArgs = [
      '-f', 'avfoundation',
      '-i', ':BlackHole 2ch',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-sample_fmt', 's16',
      '-f', 's16le',
      '-'
    ]
  } else {
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

  console.log(`[audioCapture] Запуск ffmpeg (system): ${ffmpegArgs.join(' ')}`)

  try {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    ffmpegSystemProcess = ffmpeg

    let stderrBuffer = ''
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrBuffer += text
      const lines = text.trim().split('\n')
      for (const line of lines) {
        if (line.includes('[error]') || line.includes('Error') ||
            line.includes('Cannot') || line.includes('No such')) {
          console.error(`[audioCapture] ffmpeg stderr (system): ${line}`)
        }
      }
    })

    let startupConfirmed = false
    const startupTimer = setTimeout(() => {
      if (!startupConfirmed) {
        startupConfirmed = true
        console.warn('[audioCapture] ⚠️ ffmpeg system: данные не поступают')
        if (stderrBuffer.length > 0) {
          console.warn(`[audioCapture]    stderr: ${stderrBuffer.slice(-300)}`)
        }
      }
    }, 5000)

    ffmpeg.stdout?.on('data', (data: Buffer) => {
      if (!startupConfirmed) {
        startupConfirmed = true
        clearTimeout(startupTimer)
        console.log(`[audioCapture] ✅ ffmpeg system — первые данные (${data.length} байт)`)
      }
      systemChunkBuf?.push(data)
    })

    ffmpeg.on('error', (err: Error) => {
      console.error('[audioCapture] ❌ ffmpeg error (system):', err.message)
      clearTimeout(startupTimer)
      ffmpegSystemProcess = null
    })

    ffmpeg.on('close', (code) => {
      console.log(`[audioCapture] ffmpeg system exited code=${code}`)
      clearTimeout(startupTimer)
      ffmpegSystemProcess = null
    })

    return true
  } catch (err) {
    console.error('[audioCapture] ❌ ffmpeg не запустился:', (err as Error).message)
    return false
  }
}

function killFfmpegProcess(proc: ChildProcess | null, source: AudioSource): void {
  if (!proc) return
  if (proc.killed || proc.exitCode !== null) return
  try {
    proc.kill('SIGKILL')
  } catch {
    try { proc.kill() } catch (e) {
      console.warn(`[audioCapture] Не удалось убить ffmpeg (${source}):`, (e as Error).message)
    }
  }
}

// ─── Приём микрофонных чанков от Renderer ───────────────────────────

/**
 * Вызывается когда Renderer отправляет PCM-чанк микрофона
 * через IPC (audio:sendMicChunk).
 *
 * Данные уже в формате 16kHz, Mono, 16-bit PCM —
 * просто кормим в ChunkBuffer.
 */
export function handleMicChunkFromRenderer(data: ArrayBuffer): void {
  if (!captureState.mic) return
  const buf = Buffer.from(data)
  micChunkBuf?.push(buf)
}

// ─── Публичный API ───────────────────────────────────────────────────

export function setChunkCallback(cb: AudioChunkCallback): void {
  chunkCallback = cb
}

/**
 * Запуск захвата.
 *
 * 'mic'  — создаёт ChunkBuffer в main, отправляет сигнал
 *          Renderer-у начать getUserMedia. Сама запись
 *          происходит в Renderer (audioCapture hook).
 *
 * 'system' — WASAPI loopback или ffmpeg fallback.
 *            Все ошибки обёрнуты в try/catch.
 */
export async function startCapture(source: AudioSource): Promise<boolean> {
  if (captureState[source]) {
    console.warn(`[audioCapture] ${source} уже захватывается`)
    return true
  }

  console.log(`[audioCapture] Запуск захвата: ${source}`)

  if (source === 'system') {
    try {
      // Пытаемся WASAPI
      if (!nativeLoadFailed && !nativeCaptureInstance) {
        loadNativeLoopback()
      }
      if (process.platform === 'win32' && nativeCaptureInstance && !nativeLoadFailed) {
        const nativeOk = await startNativeLoopbackCapture()
        if (nativeOk) {
          captureState.system = true
          return true
        }
        console.warn('[audioCapture] WinAudioCapture не удался, пробуем ffmpeg')
      }

      // Fallback через ffmpeg
      systemChunkBuf = new ChunkBuffer('system', SAMPLE_RATE, CHANNELS)
      const ffmpegOk = startFfmpegSystemCapture()
      if (!ffmpegOk) {
        console.error('[audioCapture] ❌ Системный звук: все методы провалились')
        return false
      }
      captureState.system = true
      return true
    } catch (err) {
      console.error('[audioCapture] ❌ Системный звук: неожиданная ошибка:', (err as Error).message)
      return false
    }
  }

  // ─── Микрофон ───
  // Создаём буфер, устанавливаем флаг.
  // Фактический захват происходит в Renderer через getUserMedia.
  // Renderer получит сигнал через IPC (audio:micCaptureStart).
  micChunkBuf = new ChunkBuffer('mic', SAMPLE_RATE, CHANNELS)
  captureState.mic = true
  console.log('[audioCapture] ✅ Микрофон: ChunkBuffer создан, ожидаем данные от Renderer')
  return true
}

export function stopCapture(source: AudioSource): void {
  if (!captureState[source]) return
  console.log(`[audioCapture] Остановка захвата: ${source}`)

  if (source === 'system') {
    try { stopNativeLoopbackCapture() } catch { /* safe */ }
    killFfmpegProcess(ffmpegSystemProcess, 'system')
    ffmpegSystemProcess = null
    systemChunkBuf?.flush()
    systemChunkBuf = null
    captureState.system = false
  } else {
    // Renderer получит сигнал через IPC (audio:micCaptureStop)
    micChunkBuf?.flush()
    micChunkBuf = null
    captureState.mic = false
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
 * Создаёт callback для отправки чанков в renderer через IPC.
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
