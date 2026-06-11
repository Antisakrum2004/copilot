"use strict";
const electron = require("electron");
const path = require("path");
const Store = require("electron-store");
const IPC = {
  audio: {
    startStreams: "audio:startStreams",
    stopStreams: "audio:stopStreams",
    startNativeLoopback: "audio:startNativeLoopback",
    stopNativeLoopback: "audio:stopNativeLoopback",
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
    isWindowOpen: "transcription:is-window-open"
  },
  suggestion: {
    show: "suggestion:show",
    hideAll: "suggestion:hide-all",
    updateContent: "suggestion:update-content",
    setOpacity: "suggestion:set-opacity",
    setWidth: "suggestion:set-width",
    setHeight: "suggestion:set-height",
    toggleVisibility: "suggestion:toggle-visibility",
    openWindow: "open-suggestion-window"
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
const DEFAULT_SETTINGS = {
  openRouterApiKey: "",
  openRouterModel: "qwen/qwen-2.5-coder-32b-instruct",
  sttApiKey: "",
  sttProvider: "groq",
  overlayOpacity: 0.85,
  overlayWidth: 420
};
const store = new Store({
  name: "settings",
  defaults: DEFAULT_SETTINGS
});
function getAllSettings() {
  return { ...DEFAULT_SETTINGS, ...store.store };
}
function saveSetting(key, value) {
  store.set(key, value);
  return getAllSettings();
}
function getSetting(key) {
  return store.get(key, DEFAULT_SETTINGS[key]);
}
const OVERLAY_DEFAULTS = {
  toolbar: { width: 360, height: 64, minWidth: 200, minHeight: 60 },
  suggestion: { width: 420, height: 320, minWidth: 280, minHeight: 120 },
  transcript: { width: 380, height: 420, minWidth: 280, minHeight: 160 }
};
function overlayWebPreferences(preloadPath) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
    backgroundThrottling: false
  };
}
function baseOverlayOptions(preloadPath, size) {
  const display = electron.screen.getPrimaryDisplay();
  const { width: screenW } = display.workAreaSize;
  return {
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    maxWidth: 2e3,
    maxHeight: 800,
    x: Math.round(screenW / 2 - size.width / 2),
    y: 48,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    ...process.platform === "darwin" ? { type: "panel" } : {},
    webPreferences: overlayWebPreferences(preloadPath)
  };
}
function setupDynamicMousePassthrough(win) {
  win.on("mouseenter", () => {
    win.setIgnoreMouseEvents(false);
  });
  win.on("mouseleave", () => {
    win.setIgnoreMouseEvents(true, { forward: true });
  });
}
function createOverlayWindow(kind, preloadPath, hash) {
  const defaults = OVERLAY_DEFAULTS[kind];
  const width = kind === "suggestion" ? getSetting("overlayWidth") : defaults.width;
  const size = { ...defaults, width };
  const options = baseOverlayOptions(preloadPath, size);
  if (kind === "toolbar") {
    options.focusable = true;
  }
  const win = new electron.BrowserWindow(options);
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${hash}`);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash: `/${hash}` });
  }
  if (kind === "toolbar") {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    setupDynamicMousePassthrough(win);
  }
  win.setOpacity(getSetting("overlayOpacity"));
  win.once("ready-to-show", () => {
    win.showInactive();
  });
  return win;
}
function applyOverlayMousePassthrough(win, ignore, forward = true) {
  if (ignore) {
    win.setIgnoreMouseEvents(true, { forward });
  } else {
    win.setIgnoreMouseEvents(false);
  }
}
function moveWindowByDelta(win, dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}
const SAMPLE_RATE = 16e3;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const CHUNK_DURATION_MS = 6e3;
const CHUNK_SIZE_SAMPLES = SAMPLE_RATE * CHUNK_DURATION_MS / 1e3;
const CHUNK_SIZE_BYTES = CHUNK_SIZE_SAMPLES * (BITS_PER_SAMPLE / 8);
let captureState = { mic: false, system: false };
let chunkCallback = null;
let nativeLoopback = null;
let ffmpegMicProcess = null;
let ffmpegSystemProcess = null;
function loadNativeLoopback() {
  if (process.platform !== "win32") {
    console.warn("[audioCapture] WASAPI loopback доступен только на Windows");
    return;
  }
  if (nativeLoopback) return;
  try {
    const mod = require("win-audio-capture");
    nativeLoopback = {
      start: (cb) => {
        mod.startCapture((buffer) => {
          cb(buffer);
        });
      },
      stop: () => {
        mod.stopCapture();
      }
    };
    console.log("[audioCapture] Нативный WASAPI loopback загружен");
  } catch (err) {
    console.warn("[audioCapture] win-audio-capture не найден, используем fallback:", err.message);
    nativeLoopback = null;
  }
}
function convertToTargetFormat(inputBuffer, inputSampleRate, inputChannels) {
  const inputSamples = inputBuffer.length / (BITS_PER_SAMPLE / 8) / inputChannels;
  const outputSamples = Math.round(inputSamples * SAMPLE_RATE / inputSampleRate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * inputSampleRate / SAMPLE_RATE;
    const srcIndexFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcIndexFloor;
    let monoSample;
    if (inputChannels === 1) {
      const offset = srcIndexFloor * 2;
      monoSample = offset + 1 < inputBuffer.length ? inputBuffer.readInt16LE(offset) : 0;
    } else {
      let sum = 0;
      for (let ch = 0; ch < inputChannels; ch++) {
        const offset = (srcIndexFloor * inputChannels + ch) * 2;
        if (offset + 1 < inputBuffer.length) {
          sum += inputBuffer.readInt16LE(offset);
        }
      }
      monoSample = Math.round(sum / inputChannels);
    }
    if (srcIndexFloor + 1 < inputSamples && frac > 0) {
      let nextMonoSample;
      if (inputChannels === 1) {
        const offset = (srcIndexFloor + 1) * 2;
        nextMonoSample = offset + 1 < inputBuffer.length ? inputBuffer.readInt16LE(offset) : 0;
      } else {
        let sum = 0;
        for (let ch = 0; ch < inputChannels; ch++) {
          const offset = ((srcIndexFloor + 1) * inputChannels + ch) * 2;
          if (offset + 1 < inputBuffer.length) {
            sum += inputBuffer.readInt16LE(offset);
          }
        }
        nextMonoSample = Math.round(sum / inputChannels);
      }
      monoSample = Math.round(monoSample * (1 - frac) + nextMonoSample * frac);
    }
    monoSample = Math.max(-32768, Math.min(32767, monoSample));
    output.writeInt16LE(monoSample, i * 2);
  }
  return output;
}
class ChunkBuffer {
  buffer = Buffer.alloc(0);
  source;
  inputSampleRate;
  inputChannels;
  constructor(source, inputSampleRate, inputChannels) {
    this.source = source;
    this.inputSampleRate = inputSampleRate;
    this.inputChannels = inputChannels;
  }
  /** Добавить аудио-данные в буфер */
  push(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= CHUNK_SIZE_BYTES) {
      const chunk = this.buffer.subarray(0, CHUNK_SIZE_BYTES);
      this.buffer = this.buffer.subarray(CHUNK_SIZE_BYTES);
      const converted = convertToTargetFormat(chunk, this.inputSampleRate, this.inputChannels);
      if (chunkCallback) {
        chunkCallback(this.source, converted, SAMPLE_RATE, CHANNELS);
      }
    }
  }
  /** Сбросить буфер */
  reset() {
    this.buffer = Buffer.alloc(0);
  }
  /** Оставшиеся данные (flush) */
  flush() {
    if (this.buffer.length > 0 && chunkCallback) {
      const converted = convertToTargetFormat(
        this.buffer,
        this.inputSampleRate,
        this.inputChannels
      );
      chunkCallback(this.source, converted, SAMPLE_RATE, CHANNELS);
    }
    this.buffer = Buffer.alloc(0);
  }
}
function startFallbackCapture(source, chunkBuf) {
  const { spawn } = require("child_process");
  let ffmpegArgs;
  if (source === "system" && process.platform === "win32") {
    ffmpegArgs = [
      "-f",
      "dshow",
      "-i",
      "audio=Stereo Mix (Realtek Audio)",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-sample_fmt",
      "s16",
      "-f",
      "s16le",
      "-"
    ];
  } else if (source === "system" && process.platform === "darwin") {
    ffmpegArgs = [
      "-f",
      "avfoundation",
      "-i",
      ":BlackHole 2ch",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-sample_fmt",
      "s16",
      "-f",
      "s16le",
      "-"
    ];
  } else if (source === "mic") {
    const deviceFormat = process.platform === "win32" ? "dshow" : process.platform === "darwin" ? "avfoundation" : "alsa";
    const deviceName = process.platform === "win32" ? "audio=Microphone" : process.platform === "darwin" ? ":Built-in Microphone" : "default";
    ffmpegArgs = [
      "-f",
      deviceFormat,
      "-i",
      deviceName,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-sample_fmt",
      "s16",
      "-f",
      "s16le",
      "-"
    ];
  } else {
    ffmpegArgs = [
      "-f",
      "alsa",
      "-i",
      "default",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-sample_fmt",
      "s16",
      "-f",
      "s16le",
      "-"
    ];
  }
  try {
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "ignore"] });
    if (source === "system") {
      ffmpegSystemProcess = ffmpeg;
    } else {
      ffmpegMicProcess = ffmpeg;
    }
    let startupConfirmed = false;
    const startupTimer = setTimeout(() => {
      if (!startupConfirmed) {
        startupConfirmed = true;
        console.log(`[audioCapture] ffmpeg (${source}) стартовал успешно (grace period)`);
      }
    }, 2e3);
    ffmpeg.stdout?.on("data", (data) => {
      if (!startupConfirmed) {
        startupConfirmed = true;
        clearTimeout(startupTimer);
      }
      chunkBuf.push(data);
    });
    ffmpeg.on("error", (err) => {
      console.error(`[audioCapture] ffmpeg error (${source}):`, err.message);
      clearTimeout(startupTimer);
      if (source === "system") {
        ffmpegSystemProcess = null;
      } else {
        ffmpegMicProcess = null;
      }
    });
    ffmpeg.on("close", (code) => {
      console.log(`[audioCapture] ffmpeg exited (${source}) with code ${code}`);
      clearTimeout(startupTimer);
      if (source === "system") {
        ffmpegSystemProcess = null;
      } else {
        ffmpegMicProcess = null;
      }
    });
    return true;
  } catch (err) {
    console.error(`[audioCapture] Не удалось запустить ffmpeg (${source}):`, err.message);
    return false;
  }
}
function killFfmpegProcess(proc, source) {
  if (!proc) return;
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill("SIGKILL");
    console.log(`[audioCapture] ffmpeg (${source}) убит (SIGKILL)`);
  } catch {
    try {
      proc.kill();
      console.log(`[audioCapture] ffmpeg (${source}) убит (default signal)`);
    } catch (e) {
      console.warn(`[audioCapture] Не удалось убить ffmpeg (${source}):`, e.message);
    }
  }
}
let systemChunkBuf = null;
let micChunkBuf = null;
function startNativeLoopbackCapture() {
  if (!nativeLoopback) {
    console.warn("[audioCapture] Нативный loopback недоступен, fallback через ffmpeg");
    return;
  }
  systemChunkBuf = new ChunkBuffer("system", 44100, 2);
  nativeLoopback.start((buffer) => {
    systemChunkBuf?.push(buffer);
  });
}
function stopNativeLoopbackCapture() {
  if (nativeLoopback) {
    nativeLoopback.stop();
  }
  systemChunkBuf?.flush();
  systemChunkBuf = null;
}
function setChunkCallback(cb) {
  chunkCallback = cb;
}
function startCapture(source) {
  if (captureState[source]) {
    console.warn(`[audioCapture] ${source} уже захватывается`);
    return true;
  }
  if (source === "system") {
    loadNativeLoopback();
    if (process.platform === "win32" && nativeLoopback) {
      startNativeLoopbackCapture();
      captureState.system = true;
      console.log("[audioCapture] Системный звук: WASAPI loopback запущен");
      return true;
    }
    systemChunkBuf = new ChunkBuffer("system", SAMPLE_RATE, CHANNELS);
    const ffmpegOk = startFallbackCapture("system", systemChunkBuf);
    if (!ffmpegOk) {
      console.error("[audioCapture] Системный звук: ffmpeg fallback не запустился");
      return false;
    }
    captureState.system = true;
    console.log("[audioCapture] Системный звук: ffmpeg fallback запущен");
    return true;
  }
  micChunkBuf = new ChunkBuffer("mic", SAMPLE_RATE, CHANNELS);
  const micOk = startFallbackCapture("mic", micChunkBuf);
  if (!micOk) {
    console.error("[audioCapture] Микрофон: ffmpeg не запустился");
    return false;
  }
  captureState.mic = true;
  console.log("[audioCapture] Микрофон: захват запущен");
  return true;
}
function stopCapture(source) {
  if (!captureState[source]) return;
  if (source === "system") {
    stopNativeLoopbackCapture();
    killFfmpegProcess(ffmpegSystemProcess, "system");
    ffmpegSystemProcess = null;
    systemChunkBuf?.flush();
    systemChunkBuf = null;
    captureState.system = false;
    console.log("[audioCapture] Системный звук: остановлен");
  } else {
    killFfmpegProcess(ffmpegMicProcess, "mic");
    ffmpegMicProcess = null;
    micChunkBuf?.flush();
    micChunkBuf = null;
    captureState.mic = false;
    console.log("[audioCapture] Микрофон: остановлен");
  }
}
function stopAllCapture() {
  stopCapture("mic");
  stopCapture("system");
}
function getCaptureState() {
  return { ...captureState };
}
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_STT_URL = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL_GROQ = "whisper-large-v3";
const WHISPER_MODEL_OPENAI = "whisper-1";
const MIN_CHUNK_SIZE_BYTES = 32e3;
let sttQueue = [];
let isProcessing = false;
let getWindow = null;
let accumulatedTranscript = "";
function createWavBuffer(pcmData, sampleRate, channels) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmData.copy(wav, 44);
  return wav;
}
async function transcribeChunk(wavBuffer, source) {
  const provider = getSetting("sttProvider");
  const apiKey = getSetting("sttApiKey");
  if (!apiKey) {
    console.warn("[sttService] API ключ не задан");
    return null;
  }
  const url = provider === "groq" ? GROQ_STT_URL : OPENAI_STT_URL;
  const model = provider === "groq" ? WHISPER_MODEL_GROQ : WHISPER_MODEL_OPENAI;
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const filename = `chunk_${Date.now()}.wav`;
  const parts = [];
  const fileHeader = `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${filename}"\r
Content-Type: audio/wav\r
\r
`;
  parts.push(Buffer.from(fileHeader, "utf-8"));
  parts.push(wavBuffer);
  parts.push(Buffer.from("\r\n", "utf-8"));
  const modelPart = `--${boundary}\r
Content-Disposition: form-data; name="model"\r
\r
${model}\r
`;
  parts.push(Buffer.from(modelPart, "utf-8"));
  const langPart = `--${boundary}\r
Content-Disposition: form-data; name="language"\r
\r
ru\r
`;
  parts.push(Buffer.from(langPart, "utf-8"));
  const formatPart = `--${boundary}\r
Content-Disposition: form-data; name="response_format"\r
\r
json\r
`;
  parts.push(Buffer.from(formatPart, "utf-8"));
  parts.push(Buffer.from(`--${boundary}--\r
`, "utf-8"));
  const body = Buffer.concat(parts);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sttService] API error ${response.status}:`, errorText);
      return null;
    }
    const result = await response.json();
    if (!result.text || result.text.trim().length === 0) {
      return null;
    }
    return {
      text: result.text.trim(),
      source
    };
  } catch (err) {
    console.error("[sttService] Ошибка транскрипции:", err.message);
    return null;
  }
}
async function processQueue() {
  if (isProcessing || sttQueue.length === 0) return;
  isProcessing = true;
  while (sttQueue.length > 0) {
    const item = sttQueue.shift();
    const { source, chunk, sampleRate, channels } = item;
    if (chunk.length < MIN_CHUNK_SIZE_BYTES) {
      continue;
    }
    const wavBuffer = createWavBuffer(chunk, sampleRate, channels);
    const result = await transcribeChunk(wavBuffer, source);
    if (result && result.text) {
      const payload = {
        text: result.text,
        speaker: source === "mic" ? "mic" : "system",
        isFinal: true,
        timestamp: Date.now()
      };
      broadcastTranscription(payload);
      const speakerLabel = source === "mic" ? "[Микрофон]" : "[Собеседник]";
      accumulatedTranscript += `${speakerLabel}: ${result.text}
`;
    }
  }
  isProcessing = false;
}
function broadcastTranscription(payload) {
  if (!getWindow) return;
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.transcription.update, payload);
  }
  const allWindows = electron.BrowserWindow.getAllWindows();
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC.transcription.update, payload);
    }
  }
}
function initSttService(getWindowFn) {
  getWindow = getWindowFn;
  console.log("[sttService] Инициализирован");
}
function enqueueChunk(source, chunk, _sampleRate, _channels) {
  sttQueue.push({ source, chunk, sampleRate: _sampleRate, channels: _channels });
  void processQueue();
}
function getAccumulatedTranscript() {
  return accumulatedTranscript;
}
function clearTranscript() {
  accumulatedTranscript = "";
  sttQueue = [];
}
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "qwen/qwen-2.5-coder-32b-instruct";
const SYSTEM_PROMPT = `Ты — ведущий архитектор и эксперт по разработке на платформе 1С:Предприятие 8. Ты анализируешь живой текст созвона (техническое интервью, проектирование архитектуры, разбор багов). Твоя задача — выводить на экран КРАТКИЕ, емкие технические подсказки, шаблоны кода, особенности БСП (Библиотеки Стандартных Подсистем), оптимальные индексы для запросов, методы оптимизации и предупреждения о типичных ошибках (например, запросы в цикле, неявные соединения). Никакой лишней воды и общих фраз — только сухая выжимка, функции и конструкции, которые прямо сейчас помогут разработчику в диалоге. Пиши в формате Markdown.`;
const MIN_SILENCE_BEFORE_LLM = 2e3;
const MIN_TRANSCRIPT_LENGTH = 20;
const MAX_CONTEXT_CHARS = 12e3;
let isStreaming = false;
let streamAbortController = null;
let suggestionHistory = [];
let autoSendTimer = null;
function trimContext(text) {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return "...\n" + text.slice(-MAX_CONTEXT_CHARS);
}
function broadcastSuggestion(payload) {
  const allWindows = electron.BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.suggestion.updateContent, payload);
    }
  }
}
async function streamSuggestion(customTranscript) {
  const apiKey = getSetting("openRouterApiKey");
  const model = getSetting("openRouterModel") || DEFAULT_MODEL;
  if (!apiKey) {
    console.warn("[openrouter] API ключ OpenRouter не задан");
    broadcastSuggestion({
      content: "⚠️ Задайте API ключ OpenRouter в настройках",
      streaming: false
    });
    return;
  }
  if (isStreaming) {
    abortStream();
  }
  const transcript = getAccumulatedTranscript();
  if (transcript.trim().length < MIN_TRANSCRIPT_LENGTH) {
    console.log("[openrouter] Транскрипция слишком короткая, пропускаем");
    return;
  }
  isStreaming = true;
  streamAbortController = new AbortController();
  const contextText = trimContext(transcript);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT }
  ];
  for (const hist of suggestionHistory) {
    messages.push(hist);
  }
  messages.push({
    role: "user",
    content: `Вот живой текст текущего созвона:

${contextText}

Дай краткую техническую подсказку по 1С, которая прямо сейчас поможет разработчику.`
  });
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://1c-copilot.app",
        "X-Title": "1C-Copilot"
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 1024,
        temperature: 0.4
      }),
      signal: streamAbortController.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[openrouter] API error ${response.status}:`, errorText);
      broadcastSuggestion({
        content: `❌ Ошибка OpenRouter (${response.status}): ${errorText.slice(0, 200)}`,
        streaming: false
      });
      isStreaming = false;
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      console.error("[openrouter] Нет response body");
      isStreaming = false;
      return;
    }
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";
    broadcastSuggestion({ content: "", streaming: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullContent += token;
            broadcastSuggestion({
              content: fullContent,
              streaming: true
            });
          }
        } catch {
        }
      }
    }
    broadcastSuggestion({
      content: fullContent,
      streaming: false
    });
    if (fullContent) {
      suggestionHistory.push({ role: "assistant", content: fullContent });
      if (suggestionHistory.length > 3) {
        suggestionHistory = suggestionHistory.slice(-3);
      }
    }
    console.log(`[openrouter] Подсказка сгенерирована (${fullContent.length} символов)`);
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("[openrouter] Запрос прерван пользователем");
    } else {
      console.error("[openrouter] Ошибка стриминга:", err.message);
      broadcastSuggestion({
        content: `❌ Ошибка: ${err.message}`,
        streaming: false
      });
    }
  } finally {
    isStreaming = false;
    streamAbortController = null;
  }
}
function abortStream() {
  if (streamAbortController) {
    streamAbortController.abort();
    streamAbortController = null;
  }
  isStreaming = false;
  broadcastSuggestion({ content: "", streaming: false });
}
function triggerAutoSuggestion() {
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
  }
  autoSendTimer = setTimeout(() => {
    const transcript = getAccumulatedTranscript();
    if (transcript.trim().length >= MIN_TRANSCRIPT_LENGTH) {
      console.log("[openrouter] Автоматическая отправка (пауза в разговоре)");
      void streamSuggestion();
    }
  }, MIN_SILENCE_BEFORE_LLM);
}
function manualSuggestion() {
  void streamSuggestion();
}
function initOpenRouterService(getWindowFn) {
  console.log("[openrouter] Инициализирован");
}
function isStreamingActive() {
  return isStreaming;
}
let toolbarWindow = null;
let suggestionWindow = null;
let transcriptWindow = null;
function sendToRenderer(win, channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}
function broadcast(channel, payload) {
  for (const win of [toolbarWindow, suggestionWindow, transcriptWindow]) {
    sendToRenderer(win, channel, payload);
  }
}
function getAnyWindow() {
  return toolbarWindow || suggestionWindow || transcriptWindow;
}
function createMainWindows(preloadPath) {
  toolbarWindow = createOverlayWindow("toolbar", preloadPath, "toolbar");
  suggestionWindow = createOverlayWindow("suggestion", preloadPath, "suggestion");
  transcriptWindow = createOverlayWindow("transcript", preloadPath, "transcript");
  suggestionWindow.hide();
  transcriptWindow.hide();
  initSttService(() => getAnyWindow());
  initOpenRouterService();
  setupAudioPipeline();
  return toolbarWindow;
}
function setupAudioPipeline() {
  setChunkCallback((source, chunk, sampleRate, channels) => {
    enqueueChunk(source, chunk, sampleRate, channels);
    if (source === "system") {
      triggerAutoSuggestion();
    }
  });
  console.log("[handlers] Аудио-пайплайн настроен: capture → STT → OpenRouter");
}
function registerIpcHandlers() {
  electron.ipcMain.handle(IPC.settings.getAll, () => getAllSettings());
  electron.ipcMain.handle(IPC.settings.save, (_event, key, value) => saveSetting(key, value));
  electron.ipcMain.handle(
    IPC.window.setIgnoreMouseEvents,
    (event, ignore, options) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      if (win) applyOverlayMousePassthrough(win, ignore, options?.forward ?? true);
    }
  );
  electron.ipcMain.handle(IPC.window.setTransparent, (event, opacity) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (win) win.setOpacity(Math.min(1, Math.max(0.3, opacity)));
  });
  electron.ipcMain.handle(IPC.window.moveWindow, (event, dx, dy) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (win) moveWindowByDelta(win, dx, dy);
  });
  electron.ipcMain.handle(IPC.window.show, (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.showInactive();
  });
  electron.ipcMain.handle(IPC.window.hide, (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.hide();
  });
  electron.ipcMain.handle(IPC.window.toggleAllVisibility, () => {
    const anyVisible = toolbarWindow?.isVisible() || suggestionWindow?.isVisible() || transcriptWindow?.isVisible();
    if (anyVisible) {
      toolbarWindow?.hide();
      suggestionWindow?.hide();
      transcriptWindow?.hide();
    } else {
      toolbarWindow?.showInactive();
      suggestionWindow?.showInactive();
      transcriptWindow?.showInactive();
    }
  });
  electron.ipcMain.handle(IPC.suggestion.openWindow, () => {
    suggestionWindow?.showInactive();
  });
  electron.ipcMain.handle(IPC.suggestion.show, () => {
    suggestionWindow?.showInactive();
  });
  electron.ipcMain.handle(IPC.suggestion.hideAll, () => {
    suggestionWindow?.hide();
  });
  electron.ipcMain.handle(IPC.suggestion.toggleVisibility, () => {
    if (suggestionWindow?.isVisible()) suggestionWindow.hide();
    else suggestionWindow?.showInactive();
  });
  electron.ipcMain.handle(IPC.suggestion.setOpacity, (_event, opacity) => {
    saveSetting("overlayOpacity", opacity);
    suggestionWindow?.setOpacity(opacity);
    toolbarWindow?.setOpacity(opacity);
    transcriptWindow?.setOpacity(opacity);
  });
  electron.ipcMain.handle(IPC.suggestion.setWidth, (_event, width) => {
    saveSetting("overlayWidth", width);
    if (suggestionWindow && !suggestionWindow.isDestroyed()) {
      const [, h] = suggestionWindow.getSize();
      suggestionWindow.setSize(width, h);
    }
  });
  electron.ipcMain.handle(IPC.suggestion.setHeight, (_event, height) => {
    if (suggestionWindow && !suggestionWindow.isDestroyed()) {
      const [w] = suggestionWindow.getSize();
      suggestionWindow.setSize(w, height);
    }
  });
  electron.ipcMain.handle(IPC.suggestion.updateContent, (_event, payload) => {
    sendToRenderer(suggestionWindow, IPC.suggestion.updateContent, payload);
  });
  electron.ipcMain.handle(IPC.transcription.openWindow, () => {
    transcriptWindow?.showInactive();
  });
  electron.ipcMain.handle(IPC.transcription.closeWindow, () => {
    transcriptWindow?.hide();
  });
  electron.ipcMain.handle(IPC.transcription.isWindowOpen, () => transcriptWindow?.isVisible() ?? false);
  electron.ipcMain.on(IPC.transcription.update, (_event, payload) => {
    broadcast(IPC.transcription.update, payload);
  });
  electron.ipcMain.on(IPC.transcription.clear, () => {
    clearTranscript();
    broadcast(IPC.transcription.clear);
  });
  electron.ipcMain.handle(IPC.audio.startStreams, async () => {
    console.log("[handlers] Запуск аудио-захвата...");
    const micOk = startCapture("mic");
    if (micOk) {
      broadcast(IPC.audio.loopbackStarted);
      return { ok: true };
    } else {
      broadcast(IPC.audio.loopbackError, "Не удалось запустить микрофон");
      return { ok: false };
    }
  });
  electron.ipcMain.handle(IPC.audio.stopStreams, async () => {
    console.log("[handlers] Остановка аудио-захвата...");
    stopCapture("mic");
    broadcast(IPC.audio.loopbackStopped);
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.audio.startNativeLoopback, async () => {
    console.log("[handlers] Запуск WASAPI loopback...");
    const sysOk = startCapture("system");
    if (sysOk) {
      broadcast(IPC.audio.loopbackStarted);
      transcriptWindow?.showInactive();
      suggestionWindow?.showInactive();
      return { ok: true, native: process.platform === "win32" && !!getCaptureState().system };
    } else {
      broadcast(IPC.audio.loopbackError, "Не удалось запустить loopback");
      return { ok: false, native: false };
    }
  });
  electron.ipcMain.handle(IPC.audio.stopNativeLoopback, async () => {
    console.log("[handlers] Остановка WASAPI loopback...");
    stopCapture("system");
    broadcast(IPC.audio.loopbackStopped);
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.audio.enableLoopback, async () => {
    const ok = startCapture("system");
    return { ok };
  });
  electron.ipcMain.handle(IPC.audio.disableLoopback, async () => {
    stopCapture("system");
    return { ok: true };
  });
  electron.ipcMain.handle("suggestion:request", async () => {
    await manualSuggestion();
    return { ok: true };
  });
  electron.ipcMain.handle("suggestion:abort", async () => {
    abortStream();
    return { ok: true };
  });
  electron.ipcMain.handle("transcript:getCurrent", async () => {
    return getAccumulatedTranscript();
  });
  electron.ipcMain.handle("suggestion:isStreaming", async () => {
    return isStreamingActive();
  });
  console.log("[handlers] Все IPC-обработчики зарегистрированы (Шаг 3: реальные сервисы)");
}
function cleanup() {
  stopAllCapture();
  abortStream();
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.showInactive();
    }
  });
  electron.app.on("before-quit", () => {
    cleanup();
  });
  electron.app.whenReady().then(() => {
    const preloadPath = path.join(__dirname, "../preload/index.js");
    registerIpcHandlers();
    createMainWindows(preloadPath);
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        createMainWindows(preloadPath);
      }
    });
  });
  electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") electron.app.quit();
  });
}
