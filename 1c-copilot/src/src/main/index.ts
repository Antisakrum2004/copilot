import { app, BrowserWindow, net, session } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

// ─── ХАК: Направляем fetch через сетевой стек Chromium для обхода блокировок ───
globalThis.fetch = net.fetch as any

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
    // Настраиваем прокси для дефолтной сессии Chromium
    await session.defaultSession.setProxy({
      proxyRules: '153.80.159.108:64218' // Без http:// в начале, чтобы работал HTTPS туннель!
    })

    // Навешиваем авторизацию прямо на сессию (исправлена сигнатура: добавлен webContents)
    session.defaultSession.on('login', (event, _webContents, _details, authInfo, callback) => {
      console.log(`[ProxyAuth] Запрос авторизации для хоста: ${authInfo.host}, proxy: ${authInfo.isProxy}`)
      if (authInfo.isProxy) {
        event.preventDefault()
        console.log('[ProxyAuth] Токены валидны. Отправляем логин и пароль в Chromium...')
        callback('jRUfBEhc', 'YCkn2DPH')
      }
    })

    // Прогрев кэша прокси для обхода бага net.fetch (Electron #44249)
    const proxyWarmup = new BrowserWindow({ show: false })
    proxyWarmup.loadURL('https://www.google.com/favicon.ico').catch(() => {})

    const closeWarmup = () => {
      if (!proxyWarmup.isDestroyed()) proxyWarmup.destroy()
    }
    // Закрываем как только получили ответ или упали, либо по защитному таймауту
    proxyWarmup.webContents.once('did-finish-load', closeWarmup)
    proxyWarmup.webContents.once('did-fail-load', closeWarmup)
    setTimeout(closeWarmup, 3000)

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
