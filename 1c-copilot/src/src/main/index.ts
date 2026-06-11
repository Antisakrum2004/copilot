import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

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

  app.whenReady().then(() => {
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
