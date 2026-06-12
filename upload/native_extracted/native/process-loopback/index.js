'use strict';
/**
 * JS wrapper around the native process-loopback addon.
 * Falls back gracefully if the binary isn't built or the platform isn't Windows.
 */

const path = require('path');

let native = null;
let loadError = null;

if (process.platform === 'win32') {
  try {
    // Default node-gyp output location.
    native = require(path.join(__dirname, 'build', 'Release', 'process_loopback.node'));
  } catch (e) {
    loadError = e;
  }
}

function isAvailable() {
  if (!native) return false;
  try { return Boolean(native.isSupported()); } catch { return false; }
}

/**
 * Start system audio capture excluding the host process tree.
 * @param {object} opts
 * @param {number} [opts.sampleRate=16000]   8000–96000 Hz, mono int16 output
 * @param {number} [opts.excludeProcessId]   defaults to process.pid
 * @param {(buf: Buffer) => void} opts.onChunk  receives mono int16 PCM buffers
 * @returns {{ stop: () => void, info: { inputSampleRate: number, inputChannels: number } }}
 */
function startSystemLoopback(opts) {
  if (!native) {
    const err = new Error('process-loopback native addon is not available' +
      (loadError ? ': ' + loadError.message : ''));
    err.code = 'ADDON_NOT_LOADED';
    throw err;
  }
  if (!opts || typeof opts.onChunk !== 'function') {
    throw new TypeError('opts.onChunk is required');
  }
  const handle = native.createSession({
    sampleRate: opts.sampleRate || 16000,
    excludeProcessId: typeof opts.excludeProcessId === 'number'
        ? opts.excludeProcessId : process.pid,
    onChunk: opts.onChunk,
  });
  const info = native.startSession(handle);
  let stopped = false;
  return {
    info,
    stop() {
      if (stopped) return;
      stopped = true;
      try { native.stopSession(handle); } catch (_) { /* swallow */ }
    },
  };
}

module.exports = { isAvailable, startSystemLoopback };
module.exports.__loadError = loadError;
