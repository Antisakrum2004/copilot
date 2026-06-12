/**
 * openrouterService.ts — Сервис аналитики 1С через OpenRouter для 1C-Copilot
 *
 * Отправляет накопленный текст созвона на OpenRouter API
 * с параметром stream: true для потоковой генерации.
 *
 * По мере прихода токенов сразу транслирует их
 * в оверлей подсказок через IPC-канал suggestion:update-content.
 *
 * Модель по умолчанию: google/gemini-2.0-flash-001 (быстрая, умная)
 *
 * SSE-стриминг использует стандартный Node.js fetch (undici ProxyAgent),
 * НЕ net.fetch — глобальный хак globalThis.fetch = net.fetch ломал
 * ReadableStream.getReader() и SSE-парсинг.
 */

import { BrowserWindow } from 'electron'
import { IPC, type SuggestionUpdatePayload, type AppSettings } from '@shared/ipc'
import { getSetting } from '../store/settings'
import { getAccumulatedTranscript, getLastTranscriptTime } from './sttService'
import { fetchWithFallback } from './proxyFetch'

// ─── Конфигурация ────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-2.0-flash-001'

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
let streamAbortController: AbortController | null = null
let getWindow: (() => BrowserWindow | null) | null = null

// История предыдущих подсказок для контекста (последние 3)
let suggestionHistory: Array<{ role: 'assistant'; content: string }> = []

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
 * Отправляет запрос на OpenRouter API с потоковой генерацией.
 * Читает ReadableStream через .getReader() и по мере прихода токенов
 * транслирует их в оверлей через IPC.
 *
 * SSE работает через стандартный Node.js fetch (undici ProxyAgent),
 * НЕ через net.fetch — глобальный хак ломал ReadableStream.
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

  console.log(`[openrouter] Отправка запроса: модель=${model}, контекст=${contextText.length} символов`)

  isStreaming = true
  streamAbortController = new AbortController()

  // Формируем сообщения для API
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

  try {
    // Стандартный Node.js fetch через undici ProxyAgent (НЕ net.fetch!)
    // net.fetch ломал SSE-стриминг: ReadableStream.getReader() не работал
    const response = await fetchWithFallback(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://1c-copilot.app',
        'X-Title': '1C-Copilot'
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 1024,
        temperature: 0.4
      }),
      signal: streamAbortController.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[openrouter] API error ${response.status}:`, errorText)
      broadcastSuggestion({
        content: `❌ Ошибка OpenRouter (${response.status}): ${errorText.slice(0, 200)}`,
        streaming: false
      })
      isStreaming = false
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      console.error('[openrouter] Нет response body — SSE стрим не доступен')
      isStreaming = false
      return
    }

    const decoder = new TextDecoder()
    let fullContent = ''
    let buffer = ''

    // НЕ отправляем пустой статус стриминга — это показывает
    // пустой "stream" бейдж и "Продолжение следует".
    // Сначала дождёмся первого токена, потом обновим UI.

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
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
          // Некорректный JSON — пропускаем
        }
      }
    }

    // Финальная отправка
    broadcastSuggestion({
      content: fullContent,
      streaming: false
    })

    // Сохраняем в историю для контекста следующих запросов
    if (fullContent) {
      suggestionHistory.push({ role: 'assistant', content: fullContent })
      // Оставляем только последние 3 подсказки
      if (suggestionHistory.length > 3) {
        suggestionHistory = suggestionHistory.slice(-3)
      }
      console.log(`[openrouter] Подсказка сгенерирована (${fullContent.length} символов)`)
    } else {
      console.warn('[openrouter] LLM вернул пустой ответ')
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.log('[openrouter] Запрос прерван пользователем')
    } else {
      console.error('[openrouter] Ошибка стриминга:', (err as Error).message)
      broadcastSuggestion({
        content: `❌ Ошибка: ${(err as Error).message}`,
        streaming: false
      })
    }
  } finally {
    isStreaming = false
    streamAbortController = null
  }
}

/**
 * Прервать текущий стриминг.
 */
export function abortStream(): void {
  if (streamAbortController) {
    streamAbortController.abort()
    streamAbortController = null
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

export function initOpenRouterService(getWindowFn: () => BrowserWindow | null): void {
  getWindow = getWindowFn
  console.log('[openrouter] Инициализирован')
}

export function isStreamingActive(): boolean {
  return isStreaming
}

export function clearSuggestionHistory(): void {
  suggestionHistory = []
}
