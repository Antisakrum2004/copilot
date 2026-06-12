import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

// ─── ПРОКСИ через Node.js (undici), а не через Chromium ───
// Chromium net.fetch НЕ поддерживает прокси-авторизацию (Electron bug #44249):
//   session.on('login') не триггерится для net.fetch,
//   прогрев через BrowserWindow тоже не помогает — туннель падает
//   с ERR_TUNNEL_CONNECTION_FAILED до этапа авторизации.
// Решение: используем Node.js native fetch + undici ProxyAgent,
// который полностью обходит стек Chromium и шлёт авторизацию сам.
import { ProxyAgent, setGlobalDispatcher } from 'undici'

const PROXY_HOST = '153.80.159.108'
const PROXY_PORT = '64218'
const PROXY_USER = 'jRUfBEhc'
const PROXY_PASS = 'YCkn2DPH'
const PROXY_URL = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`

setGlobalDispatcher(new ProxyAgent(PROXY_URL))
console.log(`[Proxy] undici ProxyAgent установлен: ${PROXY_HOST}:${PROXY_PORT}`)

// ВАЖНО: НЕ переопределяем globalThis.fetch на net.fetch!
// Node.js native fetch (undici-based) теперь идёт через прокси автоматически.

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.showInactive()
    }
  })

  // ─── ИСПРАВЛЕНО: Глобальная очистка при выходе приложения ───
  // Останавливает все аудио-стримы и убивает ffmpeg-процессы
  // перед завершением, предотвращая зомби-процессы.
  app.on('before-quit', () => {
    cleanup()
  })

  app.whenReady().then(async () => {
    const preloadPath = join(__dirname, '../preload/index.js')
    registerIpcHandlers()
    createMainWindows(preloadPath)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindows(preloadPath)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
