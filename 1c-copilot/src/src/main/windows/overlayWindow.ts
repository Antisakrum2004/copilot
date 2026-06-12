import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { getSetting } from '../store/settings'

export type OverlayWindowKind = 'toolbar' | 'suggestion' | 'transcript'

const OVERLAY_DEFAULTS: Record<
  OverlayWindowKind,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  toolbar: { width: 360, height: 64, minWidth: 200, minHeight: 60 },
  suggestion: { width: 420, height: 320, minWidth: 280, minHeight: 120 },
  transcript: { width: 380, height: 420, minWidth: 280, minHeight: 160 }
}

function overlayWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
    backgroundThrottling: false
  }
}

/** Base BrowserWindow options from ShadowHint overlay analysis. */
function baseOverlayOptions(
  preloadPath: string,
  size: { width: number; height: number; minWidth: number; minHeight: number },
  kind: OverlayWindowKind
): Electron.BrowserWindowConstructorOptions {
  const display = screen.getPrimaryDisplay()
  const { width: screenW } = display.workAreaSize

  // Тулбар и расшифровка ДОЛЖНЫ быть focusable и кликабельными
  const isToolbar = kind === 'toolbar'
  const isTranscript = kind === 'transcript'
  const isInteractive = isToolbar || isTranscript

  // Для DEBAG: suggestion — тёмный непрозрачный фон + рамка,
  // чтобы окно было ВИДНО сразу после запуска.
  // После отладки вернуть transparent: true + backgroundColor: '#00000000'
  const isDebugPanel = !isToolbar && !isTranscript

  return {
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    maxWidth: 2000,
    maxHeight: 800,
    x: Math.round(screenW / 2 - size.width / 2),
    y: isToolbar ? 48 : 120,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: isInteractive,
    frame: isDebugPanel,         // suggestion: видимая рамка для дебага
    transparent: !isDebugPanel,  // suggestion: НЕ прозрачные
    hasShadow: isDebugPanel,
    backgroundColor: isDebugPanel ? '#14141e' : '#00000000',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: overlayWebPreferences(preloadPath)
  }
}

export function createOverlayWindow(
  kind: OverlayWindowKind,
  preloadPath: string,
  hash: string
): BrowserWindow {
  const defaults = OVERLAY_DEFAULTS[kind]
  const width = kind === 'suggestion' ? getSetting('overlayWidth') : defaults.width
  const size = { ...defaults, width }

  const options = baseOverlayOptions(preloadPath, size, kind)
  const win = new BrowserWindow(options)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${hash}` })
  }

  win.setOpacity(getSetting('overlayOpacity'))

  // ─── Настройка мышиного поведения по типу окна ───

  if (kind === 'toolbar') {
    // Тулбар ВСЕГДА кликабельный — мышь никогда не проходит сквозь.
    win.once('ready-to-show', () => {
      win.show()
      win.setIgnoreMouseEvents(false)
      console.log('[overlayWindow] Toolbar показан и кликабелен')
    })
  } else if (kind === 'transcript') {
    // Расшифровка — кликабельна и интерактивна всегда.
    // Пользователь должен мочь выделять текст, скроллить, нажимать «Очистить».
    win.setIgnoreMouseEvents(false)

    win.once('ready-to-show', () => {
      win.showInactive()
      console.log('[overlayWindow] Transcript показан и кликабелен')
    })
  } else {
    // suggestion — прозрачен для кликов по умолчанию,
    // чтобы не мешать работать в 1С.
    // Динамическое переключение через DOM-события (SuggestionPanel.tsx).
    win.setIgnoreMouseEvents(true, { forward: true })

    win.once('ready-to-show', () => {
      win.showInactive()
      console.log(`[overlayWindow] ${kind} показан (click-through по умолчанию)`)
    })
  }

  return win
}

export function applyOverlayMousePassthrough(
  win: BrowserWindow,
  ignore: boolean,
  forward = true
): void {
  if (ignore) {
    win.setIgnoreMouseEvents(true, { forward })
  } else {
    win.setIgnoreMouseEvents(false)
  }
}

export function moveWindowByDelta(win: BrowserWindow, dx: number, dy: number): void {
  const [x, y] = win.getPosition()
  win.setPosition(x + dx, y + dy)
}
