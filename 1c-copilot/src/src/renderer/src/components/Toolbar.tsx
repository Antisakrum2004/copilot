import { useCallback, useEffect, useRef, useState } from 'react'

type Props = {
  recording: boolean
  onToggleRecording: () => void
  onOpenSettings: () => void
}

export function Toolbar({ recording, onToggleRecording, onOpenSettings }: Props) {
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    dragRef.current = { x: e.screenX, y: e.screenY }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.x
      const dy = e.screenY - dragRef.current.y
      dragRef.current = { x: e.screenX, y: e.screenY }
      void window.copilot.window.moveWindow(dx, dy)
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div className="toolbar glass-panel" onMouseDown={onMouseDown}>
      <div className="toolbar-brand">
        <span className="toolbar-dot" />
        <span>1C Copilot</span>
      </div>
      <div className="toolbar-actions" data-no-drag>
        <button
          className={recording ? 'btn-primary' : 'btn-ghost'}
          onClick={onToggleRecording}
          title={recording ? 'Остановить захват' : 'Начать захват'}
        >
          {recording ? '● Стоп' : '▶ Слушать'}
        </button>
        <button className="btn-ghost" onClick={() => void window.copilot.suggestion.toggleVisibility()}>
          Подсказки
        </button>
        <button className="btn-ghost" onClick={() => void window.copilot.transcription.openWindow()}>
          Текст
        </button>
        <button className="btn-ghost" onClick={onOpenSettings}>
          ⚙
        </button>
      </div>
      <style>{`
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--spacing-md);
          padding: var(--spacing-sm) var(--spacing-lg);
          width: 100%;
          height: 100%;
          -webkit-app-region: no-drag;
        }
        .toolbar-brand {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          font-weight: 600;
          color: var(--accent-primary);
          white-space: nowrap;
        }
        .toolbar-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${recording ? 'var(--accent-secondary)' : 'var(--text-secondary)'};
          box-shadow: ${recording ? '0 0 8px var(--accent-secondary)' : 'none'};
        }
        .toolbar-actions {
          display: flex;
          gap: var(--spacing-sm);
          flex-wrap: nowrap;
        }
      `}</style>
    </div>
  )
}
