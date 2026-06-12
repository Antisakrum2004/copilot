import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

// ─── ДВОЙНАЯ ПРОКСИ-АРХИТЕКТУРА ───
// 1. undici ProxyAgent: для Node.js fetch (sttService → Groq Whisper)
//    Credentials встроены в CONNECT-запрос, работает с multipart/form-data
// 2. Electron session proxy: для net.request (openrouterService → OpenRouter SSE)
//    session.setProxy + session.on('login') — автоматическая авторизация
// Node.js fetch игнорирует настройки прокси Electron сессии,
// поэтому нужны оба подхода.
import { initProxy, initSessionProxy, testProxy, isProxyEnabled } from './services/proxyFetch'

// Устанавливаем undici ProxyAgent как глобальный диспетчер для Node.js fetch
initProxy()

// ВАЖНО: НЕ переопределяем globalThis.fetch на net.fetch!
// Node.js native fetch (undici-based) идёт через прокси автоматически.
// net.request (Electron Chromium stack) использует session proxy.

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
    // ─── Настройка Electron session proxy для net.request ───
    // Настраиваем session.setProxy + session.on('login') для openrouterService.
    // Должно быть вызвано ПОСЛЕ app.whenReady(), когда session доступна.
    initSessionProxy()

    // ─── Диагностика прокси (undici ProxyAgent) ───
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
