/**
 * proxyFetch.ts — Прокси-обёртка над fetch с fallback на прямое соединение
 *
 * Архитектура:
 *   1. По умолчанию: undici ProxyAgent (Node.js native fetch через HTTP прокси)
 *   2. Если прокси недоступен (ERR_TUNNEL, timeout) — автоматически переключаемся
 *      на прямое соединение (Agent без прокси)
 *
 * Почему НЕ Chromium net.fetch:
 *   Electron bug #44249 — net.fetch НЕ триггерит session.on('login')
 *   для прокси-авторизации. Warmup BrowserWindow тоже не помог.
 *   Туннель падает с ERR_TUNNEL_CONNECTION_FAILED ДО этапа авторизации.
 *   undici ProxyAgent встраивает credentials прямо в CONNECT-запрос.
 */

import { ProxyAgent, Agent, setGlobalDispatcher } from 'undici'

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
 * fetch с автоматическим fallback: сначала через прокси, если упал — напрямую.
 * Использовать вместо raw fetch() в sttService и openrouterService.
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
