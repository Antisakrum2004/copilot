type Props = {
  recording: boolean
  onToggleRecording: () => void
  onOpenSettings: () => void
}

/**
 * Toolbar — панель управления 1C-Copilot.
 *
 * Использует нативный Electron drag через CSS:
 *   - Весь тулбар: -webkit-app-region: drag  → перетаскивание окна
 *   - Кнопки:      -webkit-app-region: no-drag → кликабельны
 *
 * Это заменило JS-based drag (mouseDown→moveWindow IPC),
 * который конфликтовал с кликабельностью кнопок.
 */
export function Toolbar({ recording, onToggleRecording, onOpenSettings }: Props) {
  return (
    <div className="toolbar glass-panel">
      <div className="toolbar-brand">
        <span className="toolbar-dot" />
        <span>1C Copilot</span>
      </div>
      <div className="toolbar-actions">
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
          -webkit-app-region: drag;
          user-select: none;
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
          -webkit-app-region: no-drag;
        }
      `}</style>
    </div>
  )
}
