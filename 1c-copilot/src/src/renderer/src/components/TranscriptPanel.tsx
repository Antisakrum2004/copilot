import { useEffect, useState } from 'react'
import type { TranscriptionUpdatePayload } from '@shared/ipc'

type Line = TranscriptionUpdatePayload & { id: number }

let lineId = 0

/**
 * TranscriptPanel — панель расшифровки речи.
 *
 * Окно расшифровки ВСЕГДА кликабельно и интерактивно
 * (настроено в overlayWindow.ts — setIgnoreMouseEvents(false)).
 * Пользователь может выделять текст, скроллить, нажимать кнопки.
 */
export function TranscriptPanel() {
  const [lines, setLines] = useState<Line[]>([])

  // ─── Подписка на транскрипцию ───
  useEffect(() => {
    const offUpdate = window.copilot.transcription.onUpdate((payload) => {
      setLines((prev) => [...prev.slice(-200), { ...payload, id: ++lineId }])
    })
    const offClear = window.copilot.transcription.onClear(() => setLines([]))
    return () => {
      offUpdate()
      offClear()
    }
  }, [])

  return (
    <div className="transcript glass-panel">
      <header className="transcript-header">
        <span>Расшифровка</span>
        <button className="btn-ghost" onClick={() => window.copilot.transcription.clear()}>
          Очистить
        </button>
      </header>
      <div className="transcript-body scroll-y">
        {lines.length === 0 ? (
          <p className="transcript-empty">Ожидание речи…</p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="transcript-line glass-card">
              <span className="transcript-speaker">{line.speaker ?? '?'}</span>
              <span className="transcript-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
      <style>{`
        .transcript {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          padding: var(--spacing-md);
          gap: var(--spacing-sm);
        }
        .transcript-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 600;
          color: var(--accent-secondary);
        }
        .transcript-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .transcript-empty {
          color: var(--text-secondary);
          margin: var(--spacing-lg) 0;
          text-align: center;
        }
        .transcript-line {
          display: flex;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          font-size: var(--suggestion-font-size);
        }
        .transcript-speaker {
          flex-shrink: 0;
          width: 52px;
          color: var(--accent-primary);
          font-weight: 600;
          text-transform: uppercase;
          font-size: 10px;
        }
        .transcript-text {
          user-select: text;
          cursor: text;
        }
      `}</style>
    </div>
  )
}
