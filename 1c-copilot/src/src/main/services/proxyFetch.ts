/**
 * proxyFetch.ts — Двойная прокси-обёртка: undici + Electron session
 *
 * Архитектура:
 *   1. Node.js fetch (sttService): undici ProxyAgent — credentials встроены
 *      в CONNECT-запрос, работает надёжно для multipart/form-data
 *   2. Electron net.request (openrouterService): session.setProxy +
 *      session.on('login') — автоматическая маршрутизация через прокси
 *      с поддержкой авторизации и SSE-стриминга
 *   3. Если прокси недоступен (ERR_TUNNEL, timeout) — автоматически
 *      переключаемся на прямое соединение
 *
 * Почему sttService НЕ использует net.request:
 *   net.request не поддерживает отправку Buffer/Uint8Array body
 *   для multipart/form-data — только строковый JSON.
 *   Whisper API требует multipart с бинарным WAV-файлом.
 *
 * Почему openrouterService НЕ использует Node.js fetch:
 *   SSE-стриминг через undici ProxyAgent может терять данные
 *   при прокси-туннелировании. net.request использует Chromium stack,
 *   который лучше справляется с long-lived streaming connections.
 */

import { ProxyAgent, Agent, setGlobalDispatcher } from 'undici'
import { session } from 'electron'

// ─── Конфигурация прокси ──────────────────────────────────────────

const PROXY_HOST = '153.80.159.108'
const PROXY_PORT = '64218'
const PROXY_USER = 'jRUfBEhc'
const PROXY_PASS = 'YCkn2DPH'
const PROXY_URL = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`

// ─── Агенты ───────────────────────────────────────────────────────

const proxyAgent = new ProxyAgent(PROXY_URL)
const directAgent = new Agent()

/** Текущий режим: true = через прокси, false = напрямую */
let proxyEnabled = true

/** Установить ProxyAgent как глобальный диспетчер */
export function initProxy(): void {
  setGlobalDispatcher(proxyAgent)
  proxyEnabled = true
  console.log(`[proxy] undici ProxyAgent установлен: ${PROXY_HOST}:${PROXY_PORT}`)
}

/** Переключиться на прямое соединение (без прокси) */
export function switchToDirect(): void {
  if (!proxyEnabled) return // уже на прямом
  setGlobalDispatcher(directAgent)
  proxyEnabled = false
  console.warn('[proxy] Переключаемся на ПРЯМОЕ соединение (без прокси)')
}

/** Переключиться обратно на прокси */
export function switchToProxy(): void {
  if (proxyEnabled) return // уже на прокси
  setGlobalDispatcher(proxyAgent)
  proxyEnabled = true
  console.log('[proxy] Переключаемся обратно на ПРОКСИ')
}

/** Текущий режим прокси */
export function isProxyEnabled(): boolean {
  return proxyEnabled
}

/**
 * Проверяет доступность прокси через тестовый запрос.
 * Возвращает true если прокси работает, false если нет.
 */
export async function testProxy(): Promise<boolean> {
  console.log('[proxy] Диагностика: проверяем прокси-соединение...')
  try {
    setGlobalDispatcher(proxyAgent)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer test' },
      signal: controller.signal
    })
    clearTimeout(timeout)

    // Любой ответ (даже 401) означает, что прокси-туннель работает
    console.log(`[proxy] Прокси РАБОТАЕТ — HTTP ${response.status} от api.groq.com`)
    proxyEnabled = true
    return true
  } catch (err: any) {
    console.error(`[proxy] Прокси НЕДОСТУПЕН: ${(err as Error).message}`)
    console.warn('[proxy] Переключаемся на прямое соединение...')
    setGlobalDispatcher(directAgent)
    proxyEnabled = false
    return false
  }
}

/**
 * Настройка Electron session proxy для net.request.
 * Вызывать ПОСЛЕ app.whenReady() — session доступна только после инициализации.
 *
 * Настраивает:
 *   - session.defaultSession.setProxy() — маршрутизация через прокси
 *   - session.defaultSession.on('login') — автоматическая авторизация
 *
 * Это позволяет net.request (из openrouterService) автоматически
 * идти через прокси с авторизацией, как обычный BrowserWindow.
 */
export function initSessionProxy(): void {
  try {
    session.defaultSession.setProxy({
      proxyRules: `${PROXY_HOST}:${PROXY_PORT}`,
      proxyBypassRules: '<-loopback>, localhost, 127.0.0.1'
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session.defaultSession as any).on(
      'login',
      (event: any, _webContents: any, _details: any, authInfo: any, callback: any) => {
        console.log(
          `[proxy] session.on('login') — isProxy: ${authInfo?.isProxy}, host: ${authInfo?.host || 'unknown'}`
        )
        event.preventDefault()
        callback(PROXY_USER, PROXY_PASS)
      }
    )

    console.log(`[proxy] Electron session proxy настроен для net.request: ${PROXY_HOST}:${PROXY_PORT}`)
  } catch (err) {
    console.warn('[proxy] Не удалось настроить Electron session proxy:', (err as Error).message)
  }
}

/**
 * fetch с автоматическим fallback: сначала через прокси, если упал — напрямую.
 * Использовать вместо raw fetch() в sttService (для multipart/form-data).
 * НЕ использовать для SSE-стриминга — для этого net.request.
 */
export async function fetchWithFallback(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // Попытка 1: через текущий диспетчер (прокси или direct)
  try {
    const response = await fetch(url, options)
    return response
  } catch (err: any) {
    const msg = (err as Error).message || ''

    // Если ошибка связана с прокси — переключаемся на direct и пробуем ещё раз
    if (
      msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
      msg.includes('ERR_PROXY') ||
      msg.includes('ProxyAgent') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('tunnel')
    ) {
      console.warn(`[proxy] Ошибка прокси: ${msg}`)
      console.warn('[proxy] Fallback: пробуем напрямую...')

      switchToDirect()

      // Попытка 2: прямое соединение
      try {
        const response = await fetch(url, options)
        return response
      } catch (directErr: any) {
        // Прямое тоже не работает — пробуем вернуть прокси на место
        switchToProxy()
        throw directErr
      }
    }

    // Другая ошибка — просто пробрасываем
    throw err
  }
}
