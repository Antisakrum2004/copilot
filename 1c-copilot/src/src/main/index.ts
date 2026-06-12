import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

// ─── ПРОКСИ через Node.js (undici), а не через Chromium ───
// Chromium net.fetch НЕ поддерживает прокси-авторизацию (Electron bug #44249):
//   session.on('login') не триггерится для net.fetch,
//   прогрев через BrowserWindow тоже не помогает — туннель падает
//   с ERR_TUNNEL_CONNECTION_FAILED до этапа авторизации.
// Решение: undici ProxyAgent + setGlobalDispatcher — Node.js native fetch
// идёт через прокси, авторизация встроена в URL.
// Если прокси недоступен — автоматически fallback на прямое соединение.
import { initProxy, testProxy, isProxyEnabled } from './services/proxyFetch'

// Устанавливаем ProxyAgent как глобальный диспетчер
initProxy()

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

  // ─── Глобальная очистка при выходе приложения ───
  // Останавливает все аудио-стримы и убивает ffmpeg-процессы
  // перед завершением, предотвращая зомби-процессы.
  app.on('before-quit', () => {
    cleanup()
  })

  app.whenReady().then(async () => {
    // ─── Диагностика прокси (ЗАДАЧА 1) ───
    // Проверяем что прокси реально работает ДО создания окон.
    // Если прокси недоступен — автоматически переключимся на direct.
    const proxyOk = await testProxy()
    if (proxyOk) {
      console.log('[proxy] setProxy OK — прокси работает')
    } else {
      console.warn('[proxy] setProxy FAILED — работаем напрямую')
    }
    console.log(`[proxy] Режим: ${isProxyEnabled() ? 'ПРОКСИ' : 'ПРЯМОЕ'}`)

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
