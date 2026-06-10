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
  size: { width: number; height: number; minWidth: number; minHeight: number }
): Electron.BrowserWindowConstructorOptions {
  const display = screen.getPrimaryDisplay()
  const { width: screenW } = display.workAreaSize

  return {
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    maxWidth: 2000,
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
    backgroundColor: '#00000000',
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

  const win = new BrowserWindow(baseOverlayOptions(preloadPath, size))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${hash}` })
  }

  win.setIgnoreMouseEvents(false)
  win.setOpacity(getSetting('overlayOpacity'))

  win.once('ready-to-show', () => {
    win.showInactive()
  })

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
