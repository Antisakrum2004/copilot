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

/**
 * Настраивает динамическое переключение мышиного passthrough:
 * - Курсор входит в окно → окно становится кликабельным
 * - Курсор покидает окно → окно снова прозрачно для кликов
 *
 * Это позволяет панелям не мешать работе в 1С, но даёт
 * возможность взаимодействовать с ними при наведении.
 */
export function setupDynamicMousePassthrough(win: BrowserWindow): void {
  win.on('mouseenter', () => {
    win.setIgnoreMouseEvents(false)
  })
  win.on('mouseleave', () => {
    win.setIgnoreMouseEvents(true, { forward: true })
  })
}

export function createOverlayWindow(
  kind: OverlayWindowKind,
  preloadPath: string,
  hash: string
): BrowserWindow {
  const defaults = OVERLAY_DEFAULTS[kind]
  const width = kind === 'suggestion' ? getSetting('overlayWidth') : defaults.width
  const size = { ...defaults, width }

  const options = baseOverlayOptions(preloadPath, size)

  // ─── Тулбар — всегда кликабельный ───
  // focusable: true позволяет окну получать фокус и корректно
  // обрабатывать клики по кнопкам и нативный drag через
  // -webkit-app-region: drag
  if (kind === 'toolbar') {
    options.focusable = true
  }

  const win = new BrowserWindow(options)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${hash}` })
  }

  // ─── Настройка мышиного поведения по типу окна ───

  if (kind === 'toolbar') {
    // Тулбар ВСЕГДА кликабельный — мышь никогда не проходит сквозь.
    // Пользователь должен иметь возможность нажимать кнопки
    // и перетаскивать тулбар по экрану.
    win.setIgnoreMouseEvents(false)
  } else {
    // suggestion / transcript — прозрачны для кликов по умолчанию,
    // чтобы не мешать работать в 1С. Но при наведении курсора
    // панели «оживают» и становятся интерактивными.
    win.setIgnoreMouseEvents(true, { forward: true })
    setupDynamicMousePassthrough(win)
  }

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
