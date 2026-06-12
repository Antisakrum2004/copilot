import { app, BrowserWindow, net } from 'electron'
import { join } from 'path'
import { createMainWindows, registerIpcHandlers, cleanup } from './ipc/handlers'

// ─── ХАК: Направляем fetch через сетевой стек Chromium для обхода блокировок ───
globalThis.fetch = net.fetch as any

// Прописываем прокси
app.commandLine.appendSwitch('proxy-server', 'http://153.80.159.108:64218')

// Авторизация на прокси-сервере
app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (authInfo.isProxy) {
    event.preventDefault()
    callback('jRUfBEhc', 'YCkn2DPH')
  }
})

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
