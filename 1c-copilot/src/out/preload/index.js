"use strict";
const electron = require("electron");
const IPC = {
  audio: {
    startStreams: "audio:startStreams",
    stopStreams: "audio:stopStreams",
    startNativeLoopback: "audio:startNativeLoopback",
    stopNativeLoopback: "audio:stopNativeLoopback",
    micChunk: "audio:micChunk",
    speakerChunk: "audio:speakerChunk",
    loopbackStarted: "audio-loopback-started",
    loopbackStopped: "audio-loopback-stopped",
    loopbackError: "audio-loopback-error",
    enableLoopback: "enable-loopback-audio",
    disableLoopback: "disable-loopback-audio"
  },
  transcription: {
    update: "transcription-update",
    clear: "transcription-clear",
    openWindow: "transcription:open-window",
    closeWindow: "transcription:close-window",
    isWindowOpen: "transcription:is-window-open",
    /** Получить текущий накопленный текст созвона */
    getCurrent: "transcript:getCurrent"
  },
  suggestion: {
    show: "suggestion:show",
    hideAll: "suggestion:hide-all",
    updateContent: "suggestion:update-content",
    setOpacity: "suggestion:set-opacity",
    setWidth: "suggestion:set-width",
    setHeight: "suggestion:set-height",
    toggleVisibility: "suggestion:toggle-visibility",
    openWindow: "open-suggestion-window",
    /** Запросить подсказку у LLM вручную */
    request: "suggestion:request",
    /** Прервать текущий стриминг */
    abort: "suggestion:abort",
    /** Узнать, стримится ли сейчас ответ */
    isStreaming: "suggestion:isStreaming"
  },
  window: {
    setIgnoreMouseEvents: "window:setIgnoreMouseEvents",
    setTransparent: "window:setTransparent",
    moveWindow: "window:moveWindow",
    show: "window:show",
    hide: "window:hide",
    toggleAllVisibility: "window:toggleAllVisibility"
  },
  settings: {
    getAll: "settings:getAllSettings",
    save: "settings:saveSetting"
  }
};
function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  electron.ipcRenderer.on(channel, handler);
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
const api = {
  settings: {
    getAll: () => electron.ipcRenderer.invoke(IPC.settings.getAll),
    save: (key, value) => electron.ipcRenderer.invoke(IPC.settings.save, key, value)
  },
  window: {
    setIgnoreMouseEvents: (ignore, options) => electron.ipcRenderer.invoke(IPC.window.setIgnoreMouseEvents, ignore, options),
    setTransparent: (opacity) => electron.ipcRenderer.invoke(IPC.window.setTransparent, opacity),
    moveWindow: (dx, dy) => electron.ipcRenderer.invoke(IPC.window.moveWindow, dx, dy),
    show: () => electron.ipcRenderer.invoke(IPC.window.show),
    hide: () => electron.ipcRenderer.invoke(IPC.window.hide),
    toggleAllVisibility: () => electron.ipcRenderer.invoke(IPC.window.toggleAllVisibility)
  },
  audio: {
    startStreams: () => electron.ipcRenderer.invoke(IPC.audio.startStreams),
    stopStreams: () => electron.ipcRenderer.invoke(IPC.audio.stopStreams),
    startNativeLoopback: () => electron.ipcRenderer.invoke(IPC.audio.startNativeLoopback),
    stopNativeLoopback: () => electron.ipcRenderer.invoke(IPC.audio.stopNativeLoopback),
    enableLoopback: () => electron.ipcRenderer.invoke(IPC.audio.enableLoopback),
    disableLoopback: () => electron.ipcRenderer.invoke(IPC.audio.disableLoopback),
    onMicChunk: (cb) => subscribe(IPC.audio.micChunk, cb),
    onSpeakerChunk: (cb) => subscribe(IPC.audio.speakerChunk, cb),
    onLoopbackStarted: (cb) => subscribe(IPC.audio.loopbackStarted, cb),
    onLoopbackStopped: (cb) => subscribe(IPC.audio.loopbackStopped, cb),
    onLoopbackError: (cb) => subscribe(IPC.audio.loopbackError, cb)
  },
  transcription: {
    openWindow: () => electron.ipcRenderer.invoke(IPC.transcription.openWindow),
    closeWindow: () => electron.ipcRenderer.invoke(IPC.transcription.closeWindow),
    isWindowOpen: () => electron.ipcRenderer.invoke(IPC.transcription.isWindowOpen),
    pushUpdate: (payload) => electron.ipcRenderer.send(IPC.transcription.update, payload),
    clear: () => electron.ipcRenderer.send(IPC.transcription.clear),
    onUpdate: (cb) => subscribe(IPC.transcription.update, cb),
    onClear: (cb) => subscribe(IPC.transcription.clear, cb),
    getCurrent: () => electron.ipcRenderer.invoke(IPC.transcription.getCurrent)
  },
  suggestion: {
    openWindow: () => electron.ipcRenderer.invoke(IPC.suggestion.openWindow),
    show: () => electron.ipcRenderer.invoke(IPC.suggestion.show),
    hideAll: () => electron.ipcRenderer.invoke(IPC.suggestion.hideAll),
    toggleVisibility: () => electron.ipcRenderer.invoke(IPC.suggestion.toggleVisibility),
    setOpacity: (opacity) => electron.ipcRenderer.invoke(IPC.suggestion.setOpacity, opacity),
    setWidth: (width) => electron.ipcRenderer.invoke(IPC.suggestion.setWidth, width),
    setHeight: (height) => electron.ipcRenderer.invoke(IPC.suggestion.setHeight, height),
    updateContent: (payload) => electron.ipcRenderer.invoke(IPC.suggestion.updateContent, payload),
    onContentUpdate: (cb) => subscribe(IPC.suggestion.updateContent, cb),
    request: () => electron.ipcRenderer.invoke(IPC.suggestion.request),
    abort: () => electron.ipcRenderer.invoke(IPC.suggestion.abort),
    isStreaming: () => electron.ipcRenderer.invoke(IPC.suggestion.isStreaming)
  }
};
electron.contextBridge.exposeInMainWorld("copilot", api);
