import { useEffect, useRef, useState } from 'react'
import type { SuggestionUpdatePayload } from '@shared/ipc'

/**
 * SuggestionPanel — панель подсказок 1C-Copilot.
 *
 * Использует DOM-based dynamic mouse passthrough:
 *   - По умолчанию: setIgnoreMouseEvents(true, {forward:true}) — клики проходят сквозь
 *   - Курсор наведён (DOM mouseenter): setIgnoreMouseEvents(false) — панель интерактивна
 *   - Курсор ушёл (DOM mouseleave): setIgnoreMouseEvents(true, {forward:true}) — снова click-through
 *
 * BrowserWindow-события mouseenter/mouseleave НЕ работают на Windows
 * при setIgnoreMouseEvents(true), поэтому переключение делается
 * через DOM-события в renderer-процессе + IPC.
 */
export function SuggestionPanel() {
  const [content, setContent] = useState(
    'Подсказки 1С появятся здесь.\n\n' +
      'Нажмите «Слушать» на тулбаре — аудио будет захватываться, ' +
      'транскрибироваться и автоматически отправляться на анализ.\n\n' +
      'Или нажмите «Спросить ИИ» для ручного запроса.'
  )
  const [streaming, setStreaming] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // ─── DOM-based dynamic passthrough ───
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const onMouseEnter = () => {
      void window.copilot.window.setIgnoreMouseEvents(false)
    }
    const onMouseLeave = () => {
      void window.copilot.window.setIgnoreMouseEvents(true, { forward: true })
    }

    el.addEventListener('mouseenter', onMouseEnter)
    el.addEventListener('mouseleave', onMouseLeave)

    return () => {
      el.removeEventListener('mouseenter', onMouseEnter)
      el.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  // ─── Подписка на контент подсказок ───
  useEffect(() => {
    return window.copilot.suggestion.onContentUpdate((payload: SuggestionUpdatePayload) => {
      setContent(payload.content)
      setStreaming(Boolean(payload.streaming))
    })
  }, [])

  const handleRequest = async () => {
    await window.copilot.suggestion.request()
  }

  const handleAbort = async () => {
    await window.copilot.suggestion.abort()
    setStreaming(false)
  }

  return (
    <div ref={rootRef} className="suggestion glass-panel">
      <header className="suggestion-header">
        <span className="suggestion-title">Подсказки 1С</span>
        <div className="suggestion-actions">
          {streaming && <span className="suggestion-badge">stream</span>}
          {streaming ? (
            <button className="btn-ghost btn-sm" onClick={handleAbort} title="Остановить генерацию">
              ⏹
            </button>
          ) : (
            <button className="btn-ghost btn-sm" onClick={handleRequest} title="Спросить ИИ">
              💡
            </button>
          )}
        </div>
      </header>
      <div className="suggestion-body scroll-y mono">{content}</div>
      <style>{`
        .suggestion {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          padding: var(--spacing-md);
          gap: var(--spacing-sm);
        }
        .suggestion-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: var(--spacing-xs);
          border-bottom: 1px solid var(--border-color);
        }
        .suggestion-title {
          font-weight: 600;
          color: var(--accent-primary);
        }
        .suggestion-actions {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .suggestion-badge {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 999px;
          background: var(--accent-background);
          color: var(--accent-primary);
          animation: pulse 1.5s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .btn-sm {
          font-size: 14px;
          padding: 2px 6px;
          line-height: 1;
        }
        .suggestion-body {
          flex: 1;
          white-space: pre-wrap;
          line-height: 1.55;
          color: var(--text-primary);
          background: var(--suggestion-code-bg);
          border: 1px solid var(--suggestion-code-border);
          border-radius: var(--border-radius-md);
          padding: var(--spacing-md);
        }
      `}</style>
    </div>
  )
}
