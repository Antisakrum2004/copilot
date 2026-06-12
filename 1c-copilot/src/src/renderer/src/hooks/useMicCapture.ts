/**
 * useMicCapture — хук захвата микрофона в Renderer-процессе.
 *
 * Использует нативный Web Audio API:
 *   navigator.mediaDevices.getUserMedia({ audio: true })
 *   → AudioContext (16kHz, mono)
 *   → ScriptProcessorNode → Float32 → Int16 PCM
 *   → IPC audio:sendMicChunk → Main-процесс
 *
 * Активируется по IPC-сигналу audio:micCaptureStart от Main.
 * Останавливается по сигналу audio:micCaptureStop.
 */

import { useEffect, useRef, useCallback } from 'react'

const TARGET_SAMPLE_RATE = 16000
const TARGET_CHANNELS = 1

export function useMicCapture(): {
  startCapture: () => Promise<boolean>
  stopCapture: () => void
  isActive: () => boolean
} {
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const isActiveRef = useRef(false)

  const stopCapture = useCallback(() => {
    if (!isActiveRef.current) return

    isActiveRef.current = false

    try {
      processorRef.current?.disconnect()
      sourceRef.current?.disconnect()
      audioContextRef.current?.close()
      streamRef.current?.getTracks().forEach(t => t.stop())
    } catch (err) {
      console.warn('[useMicCapture] Ошибка при остановке:', (err as Error).message)
    }

    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null
    streamRef.current = null

    console.log('[useMicCapture] ⏹ Захват микрофона остановлен')
  }, [])

  const startCapture = useCallback(async (): Promise<boolean> => {
    if (isActiveRef.current) {
      console.warn('[useMicCapture] Захват уже активен')
      return true
    }

    try {
      // 1. Получаем доступ к микрофону
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: TARGET_CHANNELS,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      })
      streamRef.current = stream

      // 2. Создаём AudioContext на 16kHz
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      audioContextRef.current = ctx

      console.log(`[useMicCapture] AudioContext: sampleRate=${ctx.sampleRate}, state=${ctx.state}`)

      // 3. Подключаем MediaStream → ScriptProcessorNode
      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source

      // ScriptProcessorNode: bufferSize=4096 → ~256ms при 16kHz
      const processor = ctx.createScriptProcessor(4096, TARGET_CHANNELS, TARGET_CHANNELS)
      processorRef.current = processor

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isActiveRef.current) return

        const float32 = e.inputBuffer.getChannelData(0)

        // Конвертируем Float32 [-1, 1] → Int16 [-32768, 32767]
        const int16 = new Int16Array(float32.length)
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]))
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }

        // Отправляем PCM-чанк через IPC в Main-процесс
        try {
          window.copilot.audio.sendMicChunk(int16.buffer)
        } catch (err) {
          console.warn('[useMicCapture] Ошибка отправки чанка:', (err as Error).message)
        }
      }

      source.connect(processor)
      processor.connect(ctx.destination)

      isActiveRef.current = true
      console.log('[useMicCapture] ✅ Захват запущен: 16kHz mono 16-bit PCM via getUserMedia')
      return true
    } catch (err) {
      console.error('[useMicCapture] ❌ Ошибка запуска:', (err as Error).message)
      stopCapture()
      return false
    }
  }, [stopCapture])

  // Подписка на IPC-сигналы от Main
  useEffect(() => {
    const unsubStart = window.copilot.audio.onMicCaptureStart(() => {
      console.log('[useMicCapture] Получен сигнал micCaptureStart от Main')
      void startCapture()
    })

    const unsubStop = window.copilot.audio.onMicCaptureStop(() => {
      console.log('[useMicCapture] Получен сигнал micCaptureStop от Main')
      stopCapture()
    })

    return () => {
      unsubStart()
      unsubStop()
      stopCapture()
    }
  }, [startCapture, stopCapture])

  return {
    startCapture,
    stopCapture,
    isActive: () => isActiveRef.current,
  }
}
