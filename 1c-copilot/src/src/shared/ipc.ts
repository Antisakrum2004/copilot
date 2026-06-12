/** Shared IPC channel names (aligned with ShadowHint conventions). */
export const IPC = {
  audio: {
    startStreams: 'audio:startStreams',
    stopStreams: 'audio:stopStreams',
    startNativeLoopback: 'audio:startNativeLoopback',
    stopNativeLoopback: 'audio:stopNativeLoopback',
    micChunk: 'audio:micChunk',
    speakerChunk: 'audio:speakerChunk',
    loopbackData: 'audio-loopback-data',
    loopbackStarted: 'audio-loopback-started',
    loopbackStopped: 'audio-loopback-stopped',
    loopbackError: 'audio-loopback-error',
    enableLoopback: 'enable-loopback-audio',
    disableLoopback: 'disable-loopback-audio',
    /** Main → Renderer: начать захват микрофона через getUserMedia */
    micCaptureStart: 'audio:micCaptureStart',
    /** Main → Renderer: остановить захват микрофона */
    micCaptureStop: 'audio:micCaptureStop',
    /** Renderer → Main: PCM-чанк с микрофона (16kHz, mono, 16-bit) */
    sendMicChunk: 'audio:sendMicChunk'
  },
  transcription: {
    update: 'transcription-update',
    clear: 'transcription-clear',
    openWindow: 'transcription:open-window',
    closeWindow: 'transcription:close-window',
    isWindowOpen: 'transcription:is-window-open',
    /** Получить текущий накопленный текст созвона */
    getCurrent: 'transcript:getCurrent'
  },
  suggestion: {
    show: 'suggestion:show',
    hideAll: 'suggestion:hide-all',
    updateContent: 'suggestion:update-content',
    setOpacity: 'suggestion:set-opacity',
    setWidth: 'suggestion:set-width',
    setHeight: 'suggestion:set-height',
    toggleVisibility: 'suggestion:toggle-visibility',
    openWindow: 'open-suggestion-window',
    /** Запросить подсказку у LLM вручную */
    request: 'suggestion:request',
    /** Прервать текущий стриминг */
    abort: 'suggestion:abort',
    /** Узнать, стримится ли сейчас ответ */
    isStreaming: 'suggestion:isStreaming'
  },
  window: {
    setIgnoreMouseEvents: 'window:setIgnoreMouseEvents',
    setTransparent: 'window:setTransparent',
    moveWindow: 'window:moveWindow',
    show: 'window:show',
    hide: 'window:hide',
    toggleAllVisibility: 'window:toggleAllVisibility'
  },
  settings: {
    getAll: 'settings:getAllSettings',
    save: 'settings:saveSetting'
  }
} as const

export type AppSettings = {
  openRouterApiKey: string
  openRouterModel: string
  sttApiKey: string
  sttProvider: 'groq' | 'openai'
  overlayOpacity: number
  overlayWidth: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  openRouterApiKey: '',
  openRouterModel: 'qwen/qwen-2.5-coder-32b-instruct',
  sttApiKey: '',
  sttProvider: 'groq',
  overlayOpacity: 0.85,
  overlayWidth: 420
}

export type TranscriptionUpdatePayload = {
  text: string
  speaker?: 'mic' | 'system' | 'unknown'
  isFinal?: boolean
  timestamp?: number
}

export type SuggestionUpdatePayload = {
  content: string
  streaming?: boolean
}

export type IgnoreMouseEventsOptions = {
  forward?: boolean
}

export type AudioChunkPayload = {
  data: ArrayBuffer
  sampleRate: number
  channels: number
}
