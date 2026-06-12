/**
 * openrouterService.ts — Сервис аналитики 1С через OpenRouter для 1C-Copilot
 *
 * Отправляет накопленный текст созвона на OpenRouter API
 * с параметром stream: true для потоковой генерации.
 *
 * АРХИТЕКТУРА v2 — Electron net.request вместо Node.js fetch:
 *   - net.request использует Chromium network stack
 *   - Автоматическая маршрутизация через прокси с авторизацией
 *     (session.setProxy + session.on('login'))
 *   - SSE-стриминг через response.on('data') — надёжнее,
 *     чем ReadableStream.getReader() через undici ProxyAgent
 *   - Node.js fetch игнорирует настройки прокси Electron сессии
 *
 * Модель по умолчанию: google/gemini-2.5-flash
 */

import { BrowserWindow, net } from 'electron'
import { IPC, type SuggestionUpdatePayload } from '@shared/ipc'
import { getSetting } from '../store/settings'
import { getAccumulatedTranscript } from './sttService'

// ─── Конфигурация ────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-2.5-flash'

/** Системный промпт — жёстко зашит в код */
const SYSTEM_PROMPT = `Ты — ведущий архитектор и эксперт по разработке на платформе 1С:Предприятие 8. Ты анализируешь живой текст созвона (техническое интервью, проектирование архитектуры, разбор багов). Твоя задача — выводить на экран КРАТКИЕ, емкие технические подсказки, шаблоны кода, особенности БСП (Библиотеки Стандартных Подсистем), оптимальные индексы для запросов, методы оптимизации и предупреждения о типичных ошибках (например, запросы в цикле, неявные соединения). Никакой лишней воды и общих фраз — только сухая выжимка, функции и конструкции, которые прямо сейчас помогут разработчику в диалоге. Пиши в формате Markdown.`

// Минимальная пауза после последней транскрипции перед отправкой на LLM (мс)
const MIN_SILENCE_BEFORE_LLM = 2000
// Минимальная длина текста для отправки на LLM
const MIN_TRANSCRIPT_LENGTH = 20
// Максимум символов контекста, отправляемых в LLM
const MAX_CONTEXT_CHARS = 12000

// ─── Состояние ───────────────────────────────────────────────────────

let isStreaming = false
let currentRequest: Electron.ClientRequest | null = null

// История предыдущих подсказок для контекста (user + assistant пары)
let suggestionHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []

// Таймер для автоматической отправки при паузе в разговоре
let autoSendTimer: ReturnType<typeof setTimeout> | null = null

// ─── Вспомогательные функции ─────────────────────────────────────────

/**
 * Обрезает текст контекста до MAX_CONTEXT_CHARS,
 * оставляя последние (самые актуальные) сообщения.
 */
function trimContext(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text
  return '...\n' + text.slice(-MAX_CONTEXT_CHARS)
}

/**
 * Отправляет подсказку во все окна renderer.
 */
function broadcastSuggestion(payload: SuggestionUpdatePayload): void {
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.suggestion.updateContent, payload)
    }
  }
}

// ─── Основная функция стриминга ──────────────────────────────────────

/**
 * Отправляет запрос на OpenRouter API через Electron net.request
 * с потоковой генерацией (SSE).
 *
 * net.request использует Chromium network stack, что обеспечивает:
 *   - Автоматическую маршрутизацию через прокси (session.setProxy)
 *   - Поддержку прокси-авторизации (session.on('login'))
 *   - Надёжный SSE-стриминг через response.on('data')
 *
 * Предыдущий подход (Node.js fetch через undici ProxyAgent):
 *   - Игнорировал настройки прокси Electron сессии
 *   - Мог терять данные при SSE-стриминге через прокси-туннель
 */
export async function streamSuggestion(
  customTranscript?: string
): Promise<void> {
  const apiKey: string = getSetting('openRouterApiKey')
  const model: string = getSetting('openRouterModel') || DEFAULT_MODEL

  if (!apiKey) {
    console.warn('[openrouter] API ключ OpenRouter не задан — подсказки недоступны')
    broadcastSuggestion({
      content: '⚠️ Задайте API ключ OpenRouter в настройках (⚙️ → OpenRouter Key)',
      streaming: false
    })
    return
  }

  // Если уже стримим — прерываем предыдущий запрос
  if (isStreaming) {
    abortStream()
  }

  const transcript = customTranscript || getAccumulatedTranscript()

  if (transcript.trim().length < MIN_TRANSCRIPT_LENGTH) {
    console.log('[openrouter] Транскрипция слишком короткая, пропускаем')
    return
  }

  const contextText = trimContext(transcript)

  console.log(`[openrouter] Отправка запроса через net.request: модель=${model}, контекст=${contextText.length} символов`)

  isStreaming = true

  // Формируем сообщения для API (user/assistant пары для правильного формата chat)
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT }
  ]

  // Добавляем историю предыдущих подсказок для контекста
  for (const hist of suggestionHistory) {
    messages.push(hist)
  }

  // Текущий запрос
  messages.push({
    role: 'user',
    content: `Вот живой текст текущего созвона:\n\n${contextText}\n\nДай краткую техническую подсказку по 1С, которая прямо сейчас поможет разработчику.`
  })

  // ─── Создаём net.request ───
  const request = net.request({
    method: 'POST',
    url: OPENROUTER_URL
  })

  request.setHeader('Content-Type', 'application/json')
  request.setHeader('Authorization', `Bearer ${apiKey}`)
  request.setHeader('HTTP-Referer', 'https://1c-copilot.app')
  request.setHeader('X-Title', '1C-Copilot')

  currentRequest = request

  let fullContent = ''
  let buffer = ''

  // ─── Обработка ответа ───
  request.on('response', (response) => {
    const statusCode = response.statusCode

    // Ошибка API — собираем тело ошибки
    if (statusCode !== 200) {
      let errorBody = ''
      response.on('data', (chunk: Buffer) => {
        errorBody += chunk.toString()
      })
      response.on('end', () => {
        console.error(`[openrouter] API error ${statusCode}:`, errorBody)
        broadcastSuggestion({
          content: `❌ Ошибка OpenRouter (${statusCode}): ${errorBody.slice(0, 200)}`,
          streaming: false
        })
        isStreaming = false
        currentRequest = null
      })
      return
    }

    // ─── SSE-стриминг: разбираем data-строки ───
    response.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Последняя неполная строка остаётся в буфере

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue

        try {
          const parsed = JSON.parse(trimmed.slice(6))
          const token = parsed.choices?.[0]?.delta?.content

          if (token) {
            fullContent += token
            // Отправляем обновление ТОЛЬКО когда есть контент
            broadcastSuggestion({
              content: fullContent,
              streaming: true
            })
          }
        } catch {
          // Некорректный JSON — пропускаем (неполный чанк)
        }
      }
    })

    // ─── Конец стрима ───
    response.on('end', () => {
      // Обрабатываем оставшийся буфер
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(6))
            const token = parsed.choices?.[0]?.delta?.content
            if (token) {
              fullContent += token
            }
          } catch { /* skip */ }
        }
      }

      // Финальная отправка
      broadcastSuggestion({
        content: fullContent,
        streaming: false
      })

      // Сохраняем в историю для контекста следующих запросов (user + assistant пары)
      if (fullContent) {
        // Сохраним краткий контекст user-запроса (последние 500 символов)
        suggestionHistory.push({ role: 'user', content: contextText.slice(-500) })
        suggestionHistory.push({ role: 'assistant', content: fullContent })
        // Оставляем только последние 3 пары (6 записей)
        if (suggestionHistory.length > 6) {
          suggestionHistory = suggestionHistory.slice(-6)
        }
        console.log(`[openrouter] Подсказка сгенерирована (${fullContent.length} символов)`)
      } else {
        console.warn('[openrouter] LLM вернул пустой ответ')
      }

      isStreaming = false
      currentRequest = null
    })

    // ─── Ошибка чтения ответа ───
    response.on('error', (err: Error) => {
      console.error('[openrouter] Ошибка чтения ответа:', err.message)
      broadcastSuggestion({
        content: `❌ Ошибка чтения ответа: ${err.message}`,
        streaming: false
      })
      isStreaming = false
      currentRequest = null
    })
  })

  // ─── Ошибка запроса ───
  request.on('error', (err: Error) => {
    if (err.message.includes('aborted') || err.message.includes('ABORTED')) {
      console.log('[openrouter] Запрос прерван пользователем')
    } else {
      console.error('[openrouter] Ошибка запроса через net.request:', err.message)
      broadcastSuggestion({
        content: `❌ Ошибка: ${err.message}`,
        streaming: false
      })
    }
    isStreaming = false
    currentRequest = null
  })

  // ─── Отправка тела запроса ───
  request.write(JSON.stringify({
    model,
    messages,
    stream: true,
    max_tokens: 1024,
    temperature: 0.4
  }))

  request.end()
}

/**
 * Прервать текущий стриминг.
 */
export function abortStream(): void {
  if (currentRequest) {
    currentRequest.abort()
    currentRequest = null
  }
  isStreaming = false
  broadcastSuggestion({ content: '', streaming: false })
}

/**
 * Автоматическая отправка на LLM при паузе в разговоре.
 * Вызывается из audioCapture через callback.
 */
export function triggerAutoSuggestion(): void {
  // Сбрасываем предыдущий таймер
  if (autoSendTimer) {
    clearTimeout(autoSendTimer)
  }

  // Ставим новый таймер — отправим запрос через MIN_SILENCE_BEFORE_LLM
  // после того как собеседник замолчал
  autoSendTimer = setTimeout(() => {
    const transcript = getAccumulatedTranscript()
    if (transcript.trim().length >= MIN_TRANSCRIPT_LENGTH) {
      console.log('[openrouter] Автоматическая отправка (пауза в разговоре)')
      void streamSuggestion()
    }
  }, MIN_SILENCE_BEFORE_LLM)
}

/**
 * Ручная отправка запроса на LLM.
 */
export function manualSuggestion(): void {
  void streamSuggestion()
}

// ─── Инициализация ───────────────────────────────────────────────────

export function initOpenRouterService(_getWindowFn?: () => BrowserWindow | null): void {
  console.log('[openrouter] Инициализирован (net.request + Electron session proxy)')
}

export function isStreamingActive(): boolean {
  return isStreaming
}

export function clearSuggestionHistory(): void {
  suggestionHistory = []
}
