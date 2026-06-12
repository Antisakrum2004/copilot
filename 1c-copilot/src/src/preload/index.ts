import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppSettings,
  type AudioChunkPayload,
  type IgnoreMouseEventsOptions,
  type SuggestionUpdatePayload,
  type TranscriptionUpdatePayload
} from '@shared/ipc'

export type CopilotApi = {
  settings: {
    getAll: () => Promise<AppSettings>
    save: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<AppSettings>
  }
  window: {
    setIgnoreMouseEvents: (ignore: boolean, options?: IgnoreMouseEventsOptions) => Promise<void>
    setTransparent: (opacity: number) => Promise<void>
    moveWindow: (dx: number, dy: number) => Promise<void>
    show: () => Promise<void>
    hide: () => Promise<void>
    toggleAllVisibility: () => Promise<void>
  }
  audio: {
    startStreams: () => Promise<{ ok: boolean }>
    stopStreams: () => Promise<{ ok: boolean }>
    startNativeLoopback: () => Promise<{ ok: boolean; native?: boolean }>
    stopNativeLoopback: () => Promise<{ ok: boolean }>
    enableLoopback: () => Promise<{ ok: boolean }>
    disableLoopback: () => Promise<{ ok: boolean }>
    onMicChunk: (cb: (payload: AudioChunkPayload) => void) => () => void
    onSpeakerChunk: (cb: (payload: AudioChunkPayload) => void) => () => void
    onLoopbackStarted: (cb: () => void) => () => void
    onLoopbackStopped: (cb: () => void) => () => void
    onLoopbackError: (cb: (message: string) => void) => () => void
    /** Main → Renderer: начать getUserMedia захвата микрофона */
    onMicCaptureStart: (cb: () => void) => () => void
    /** Main → Renderer: остановить getUserMedia захвата микрофона */
    onMicCaptureStop: (cb: () => void) => () => void
    /** Renderer → Main: отправить PCM-чанк микрофона */
    sendMicChunk: (data: ArrayBuffer) => void
  }
  transcription: {
    openWindow: () => Promise<void>
    closeWindow: () => Promise<void>
    isWindowOpen: () => Promise<boolean>
    pushUpdate: (payload: TranscriptionUpdatePayload) => void
    clear: () => void
    onUpdate: (cb: (payload: TranscriptionUpdatePayload) => void) => () => void
    onClear: (cb: () => void) => () => void
    /** Получить текущий накопленный текст созвона */
    getCurrent: () => Promise<string>
  }
  suggestion: {
    openWindow: () => Promise<void>
    show: () => Promise<void>
    hideAll: () => Promise<void>
    toggleVisibility: () => Promise<void>
    setOpacity: (opacity: number) => Promise<void>
    setWidth: (width: number) => Promise<void>
    setHeight: (height: number) => Promise<void>
    updateContent: (payload: SuggestionUpdatePayload) => Promise<void>
    onContentUpdate: (cb: (payload: SuggestionUpdatePayload) => void) => () => void
    /** Запросить подсказку у LLM вручную */
    request: () => Promise<{ ok: boolean }>
    /** Прервать текущий стриминг */
    abort: () => Promise<{ ok: boolean }>
    /** Узнать, стримится ли сейчас ответ */
    isStreaming: () => Promise<boolean>
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: CopilotApi = {
  settings: {
    getAll: () => ipcRenderer.invoke(IPC.settings.getAll),
    save: (key, value) => ipcRenderer.invoke(IPC.settings.save, key, value)
  },
  window: {
    setIgnoreMouseEvents: (ignore, options) =>
      ipcRenderer.invoke(IPC.window.setIgnoreMouseEvents, ignore, options),
    setTransparent: (opacity) => ipcRenderer.invoke(IPC.window.setTransparent, opacity),
    moveWindow: (dx, dy) => ipcRenderer.invoke(IPC.window.moveWindow, dx, dy),
    show: () => ipcRenderer.invoke(IPC.window.show),
    hide: () => ipcRenderer.invoke(IPC.window.hide),
    toggleAllVisibility: () => ipcRenderer.invoke(IPC.window.toggleAllVisibility)
  },
  audio: {
    startStreams: () => ipcRenderer.invoke(IPC.audio.startStreams),
    stopStreams: () => ipcRenderer.invoke(IPC.audio.stopStreams),
    startNativeLoopback: () => ipcRenderer.invoke(IPC.audio.startNativeLoopback),
    stopNativeLoopback: () => ipcRenderer.invoke(IPC.audio.stopNativeLoopback),
    enableLoopback: () => ipcRenderer.invoke(IPC.audio.enableLoopback),
    disableLoopback: () => ipcRenderer.invoke(IPC.audio.disableLoopback),
    onMicChunk: (cb) => subscribe(IPC.audio.micChunk, cb),
    onSpeakerChunk: (cb) => subscribe(IPC.audio.speakerChunk, cb),
    onLoopbackStarted: (cb) => subscribe(IPC.audio.loopbackStarted, cb),
    onLoopbackStopped: (cb) => subscribe(IPC.audio.loopbackStopped, cb),
    onLoopbackError: (cb) => subscribe(IPC.audio.loopbackError, cb),
    onMicCaptureStart: (cb) => subscribe(IPC.audio.micCaptureStart, cb),
    onMicCaptureStop: (cb) => subscribe(IPC.audio.micCaptureStop, cb),
    sendMicChunk: (data) => ipcRenderer.send(IPC.audio.sendMicChunk, data)
  },
  transcription: {
    openWindow: () => ipcRenderer.invoke(IPC.transcription.openWindow),
    closeWindow: () => ipcRenderer.invoke(IPC.transcription.closeWindow),
    isWindowOpen: () => ipcRenderer.invoke(IPC.transcription.isWindowOpen),
    pushUpdate: (payload) => ipcRenderer.send(IPC.transcription.update, payload),
    clear: () => ipcRenderer.send(IPC.transcription.clear),
    onUpdate: (cb) => subscribe(IPC.transcription.update, cb),
    onClear: (cb) => subscribe(IPC.transcription.clear, cb),
    getCurrent: () => ipcRenderer.invoke(IPC.transcription.getCurrent)
  },
  suggestion: {
    openWindow: () => ipcRenderer.invoke(IPC.suggestion.openWindow),
    show: () => ipcRenderer.invoke(IPC.suggestion.show),
    hideAll: () => ipcRenderer.invoke(IPC.suggestion.hideAll),
    toggleVisibility: () => ipcRenderer.invoke(IPC.suggestion.toggleVisibility),
    setOpacity: (opacity) => ipcRenderer.invoke(IPC.suggestion.setOpacity, opacity),
    setWidth: (width) => ipcRenderer.invoke(IPC.suggestion.setWidth, width),
    setHeight: (height) => ipcRenderer.invoke(IPC.suggestion.setHeight, height),
    updateContent: (payload) => ipcRenderer.invoke(IPC.suggestion.updateContent, payload),
    onContentUpdate: (cb) => subscribe(IPC.suggestion.updateContent, cb),
    request: () => ipcRenderer.invoke(IPC.suggestion.request),
    abort: () => ipcRenderer.invoke(IPC.suggestion.abort),
    isStreaming: () => ipcRenderer.invoke(IPC.suggestion.isStreaming)
  }
}

contextBridge.exposeInMainWorld('copilot', api)

declare global {
  interface Window {
    copilot: CopilotApi
  }
}
