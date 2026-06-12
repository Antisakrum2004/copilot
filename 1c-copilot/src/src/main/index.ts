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
      proxyRules: 'http://153.80.159.108:64218'
    })

    // Навешиваем авторизацию прямо на сессию
    session.defaultSession.on('login', (event, _details, authInfo, callback) => {
      if (authInfo.isProxy) {
        event.preventDefault()
        callback('jRUfBEhc', 'YCkn2DPH')
      }
    })

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
