/**
 * handlers.ts — IPC-обработчики для 1C-Copilot
 *
 * Шаг 3: Интеграция реальных сервисов
 *   - audioCapture: WASAPI loopback + микрофон
 *   - sttService: Groq/OpenAI Whisper API
 *   - openrouterService: Streaming LLM для 1С-подсказок
 */

import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import {
  applyOverlayMousePassthrough,
  createOverlayWindow,
  moveWindowByDelta,
  type OverlayWindowKind
} from '../windows/overlayWindow'
import { getAllSettings, saveSetting } from '../store/settings'
import {
  startCapture,
  stopCapture,
  stopAllCapture,
  getCaptureState,
  setChunkCallback,
  createIpcChunkSender,
  type AudioSource
} from '../services/audioCapture'
import {
  initSttService,
  enqueueChunk,
  clearTranscript,
  getAccumulatedTranscript
} from '../services/sttService'
import {
  initOpenRouterService,
  streamSuggestion,
  abortStream,
  triggerAutoSuggestion,
  manualSuggestion,
  isStreamingActive
} from '../services/openrouterService'

// ─── Реестр окон ─────────────────────────────────────────────────────

type WindowRegistry = Partial<Record<OverlayWindowKind, BrowserWindow | null>>

let toolbarWindow: BrowserWindow | null = null
let suggestionWindow: BrowserWindow | null = null
let transcriptWindow: BrowserWindow | null = null

function getWindowByKind(kind: OverlayWindowKind): BrowserWindow | null {
  const map: WindowRegistry = {
    toolbar: toolbarWindow,
    suggestion: suggestionWindow,
    transcript: transcriptWindow
  }
  return map[kind] ?? null
}

function sendToRenderer(
  win: BrowserWindow | null,
  channel: string,
  payload?: unknown
): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of [toolbarWindow, suggestionWindow, transcriptWindow]) {
    sendToRenderer(win, channel, payload)
  }
}

/** Получить любое доступное окно для отправки IPC */
function getAnyWindow(): BrowserWindow | null {
  return toolbarWindow || suggestionWindow || transcriptWindow
}

// ─── Создание окон ───────────────────────────────────────────────────

export function createMainWindows(preloadPath: string): BrowserWindow {
  toolbarWindow = createOverlayWindow('toolbar', preloadPath, 'toolbar')
  suggestionWindow = createOverlayWindow('suggestion', preloadPath, 'suggestion')
  transcriptWindow = createOverlayWindow('transcript', preloadPath, 'transcript')

  suggestionWindow.hide()
  transcriptWindow.hide()

  // ─── Инициализация сервисов ──────────────────────────────────────

  // STT-сервис: отправляет результаты транскрипции во все окна
  initSttService(() => getAnyWindow())

  // OpenRouter-сервис: отправляет стриминг-подсказки в оверлей
  initOpenRouterService(() => getAnyWindow())

  // Аудио-захват: чанки → STT + автоподсказки
  setupAudioPipeline()

  return toolbarWindow
}

// ─── Пайплайн аудио → STT → LLM ─────────────────────────────────────

/**
 * Настраивает пайплайн обработки аудио:
 *   1. audioCapture нарезает чанки → callback
 *   2. callback отправляет чанки в sttService (enqueueChunk)
 *   3. sttService после успешной транскрипции вызывает
 *      triggerAutoSuggestion() для автогенерации подсказок
 */
function setupAudioPipeline(): void {
  // Основной callback: аудио-чанк → STT
  setChunkCallback((source: AudioSource, chunk: Buffer, sampleRate: number, channels: number) => {
    // 1. Отправляем чанк на транскрипцию
    enqueueChunk(source, chunk, sampleRate, channels)

    // 2. Если это системный звук (собеседник) — триггерим авто-подсказку
    //    после паузы в разговоре
    if (source === 'system') {
      triggerAutoSuggestion()
    }
  })

  console.log('[handlers] Аудио-пайплайн настроен: capture → STT → OpenRouter')
}

// ─── IPC-обработчики ─────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // --- Settings ---
  ipcMain.handle(IPC.settings.getAll, () => getAllSettings())
  ipcMain.handle(IPC.settings.save, (_event, key, value) => saveSetting(key, value))

  // --- Window ---
  ipcMain.handle(
    IPC.window.setIgnoreMouseEvents,
    (event, ignore: boolean, options?: { forward?: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) applyOverlayMousePassthrough(win, ignore, options?.forward ?? true)
    }
  )

  ipcMain.handle(IPC.window.setTransparent, (event, opacity: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.setOpacity(Math.min(1, Math.max(0.3, opacity)))
  })

  ipcMain.handle(IPC.window.moveWindow, (event, dx: number, dy: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) moveWindowByDelta(win, dx, dy)
  })

  ipcMain.handle(IPC.window.show, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.showInactive()
  })

  ipcMain.handle(IPC.window.hide, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })

  ipcMain.handle(IPC.window.toggleAllVisibility, () => {
    const anyVisible =
      toolbarWindow?.isVisible() ||
      suggestionWindow?.isVisible() ||
      transcriptWindow?.isVisible()

    if (anyVisible) {
      toolbarWindow?.hide()
      suggestionWindow?.hide()
      transcriptWindow?.hide()
    } else {
      toolbarWindow?.showInactive()
      suggestionWindow?.showInactive()
      transcriptWindow?.showInactive()
    }
  })

  // --- Suggestion ---
  ipcMain.handle(IPC.suggestion.openWindow, () => {
    suggestionWindow?.showInactive()
  })

  ipcMain.handle(IPC.suggestion.show, () => {
    suggestionWindow?.showInactive()
  })

  ipcMain.handle(IPC.suggestion.hideAll, () => {
    suggestionWindow?.hide()
  })

  ipcMain.handle(IPC.suggestion.toggleVisibility, () => {
    if (suggestionWindow?.isVisible()) suggestionWindow.hide()
    else suggestionWindow?.showInactive()
  })

  ipcMain.handle(IPC.suggestion.setOpacity, (_event, opacity: number) => {
    saveSetting('overlayOpacity', opacity)
    suggestionWindow?.setOpacity(opacity)
    toolbarWindow?.setOpacity(opacity)
    transcriptWindow?.setOpacity(opacity)
  })

  ipcMain.handle(IPC.suggestion.setWidth, (_event, width: number) => {
    saveSetting('overlayWidth', width)
    if (suggestionWindow && !suggestionWindow.isDestroyed()) {
      const [, h] = suggestionWindow.getSize()
      suggestionWindow.setSize(width, h)
    }
  })

  ipcMain.handle(IPC.suggestion.setHeight, (_event, height: number) => {
    if (suggestionWindow && !suggestionWindow.isDestroyed()) {
      const [w] = suggestionWindow.getSize()
      suggestionWindow.setSize(w, height)
    }
  })

  ipcMain.handle(IPC.suggestion.updateContent, (_event, payload) => {
    sendToRenderer(suggestionWindow, IPC.suggestion.updateContent, payload)
  })

  // --- Transcription ---
  ipcMain.handle(IPC.transcription.openWindow, () => {
    transcriptWindow?.showInactive()
  })

  ipcMain.handle(IPC.transcription.closeWindow, () => {
    transcriptWindow?.hide()
  })

  ipcMain.handle(IPC.transcription.isWindowOpen, () => transcriptWindow?.isVisible() ?? false)

  ipcMain.on(IPC.transcription.update, (_event, payload) => {
    broadcast(IPC.transcription.update, payload)
  })

  ipcMain.on(IPC.transcription.clear, () => {
    clearTranscript()
    broadcast(IPC.transcription.clear)
  })

  // --- Audio: РЕАЛЬНЫЙ ЗАХВАТ (вместо заглушек) ---

  ipcMain.handle(IPC.audio.startStreams, async () => {
    console.log('[handlers] Запуск аудио-захвата...')

    // Запускаем захват микрофона
    const micOk = startCapture('mic')

    if (micOk) {
      broadcast(IPC.audio.loopbackStarted)
      return { ok: true }
    } else {
      broadcast(IPC.audio.loopbackError, 'Не удалось запустить микрофон')
      return { ok: false }
    }
  })

  ipcMain.handle(IPC.audio.stopStreams, async () => {
    console.log('[handlers] Остановка аудио-захвата...')
    stopCapture('mic')
    broadcast(IPC.audio.loopbackStopped)
    return { ok: true }
  })

  ipcMain.handle(IPC.audio.startNativeLoopback, async () => {
    console.log('[handlers] Запуск WASAPI loopback...')

    // Запускаем захват системного звука
    const sysOk = startCapture('system')

    if (sysOk) {
      broadcast(IPC.audio.loopbackStarted)
      // Показываем окно транскрипции при старте захвата
      transcriptWindow?.showInactive()
      suggestionWindow?.showInactive()
      return { ok: true, native: process.platform === 'win32' && !!getCaptureState().system }
    } else {
      broadcast(IPC.audio.loopbackError, 'Не удалось запустить loopback')
      return { ok: false, native: false }
    }
  })

  ipcMain.handle(IPC.audio.stopNativeLoopback, async () => {
    console.log('[handlers] Остановка WASAPI loopback...')
    stopCapture('system')
    broadcast(IPC.audio.loopbackStopped)
    return { ok: true }
  })

  ipcMain.handle(IPC.audio.enableLoopback, async () => {
    const ok = startCapture('system')
    return { ok }
  })

  ipcMain.handle(IPC.audio.disableLoopback, async () => {
    stopCapture('system')
    return { ok: true }
  })

  // --- Новые IPC-каналы для LLM ---

  // Ручной запрос подсказки
  ipcMain.handle('suggestion:request', async () => {
    await manualSuggestion()
    return { ok: true }
  })

  // Прерывание стриминга
  ipcMain.handle('suggestion:abort', async () => {
    abortStream()
    return { ok: true }
  })

  // Получить текущую транскрипцию (для отладки)
  ipcMain.handle('transcript:getCurrent', async () => {
    return getAccumulatedTranscript()
  })

  // Статус стриминга
  ipcMain.handle('suggestion:isStreaming', async () => {
    return isStreamingActive()
  })

  console.log('[handlers] Все IPC-обработчики зарегистрированы (Шаг 3: реальные сервисы)')
}

export function getAppWindows() {
  return { toolbarWindow, suggestionWindow, transcriptWindow }
}

/**
 * Очистка при завершении приложения.
 */
export function cleanup(): void {
  stopAllCapture()
  abortStream()
}
