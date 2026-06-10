import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc'

type Props = {
  onClose: () => void
}

export function SettingsPanel({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.copilot.settings.getAll().then(setSettings)
  }, [])

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    try {
      for (const [key, value] of Object.entries(settings) as [keyof AppSettings, AppSettings[keyof AppSettings]][]) {
        await window.copilot.settings.save(key, value)
      }
      await window.copilot.suggestion.setOpacity(settings.overlayOpacity)
      await window.copilot.suggestion.setWidth(settings.overlayWidth)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings glass-panel">
        <p>Загрузка…</p>
      </div>
    )
  }

  return (
    <div className="settings glass-panel scroll-y">
      <header className="settings-header">
        <h2>Настройки</h2>
        <button className="btn-ghost" onClick={onClose}>
          ✕
        </button>
      </header>

      <section className="settings-section">
        <h3>OpenRouter (LLM)</h3>
        <label>
          API Key
          <input
            type="password"
            value={settings.openRouterApiKey}
            onChange={(e) => update('openRouterApiKey', e.target.value)}
            placeholder="sk-or-..."
          />
        </label>
        <label>
          Модель
          <input
            type="text"
            value={settings.openRouterModel}
            onChange={(e) => update('openRouterModel', e.target.value)}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>STT (Whisper)</h3>
        <label>
          Провайдер
          <select
            value={settings.sttProvider}
            onChange={(e) => update('sttProvider', e.target.value as AppSettings['sttProvider'])}
          >
            <option value="groq">Groq</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          API Key
          <input
            type="password"
            value={settings.sttApiKey}
            onChange={(e) => update('sttApiKey', e.target.value)}
            placeholder="gsk_... или sk-..."
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>Оверлей</h3>
        <label>
          Прозрачность: {Math.round(settings.overlayOpacity * 100)}%
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={settings.overlayOpacity}
            onChange={(e) => update('overlayOpacity', Number(e.target.value))}
          />
        </label>
        <label>
          Ширина подсказок (px)
          <input
            type="number"
            min={280}
            max={900}
            value={settings.overlayWidth}
            onChange={(e) => update('overlayWidth', Number(e.target.value))}
          />
        </label>
      </section>

      <footer className="settings-footer">
        <button className="btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </footer>

      <style>{`
        .settings {
          width: 100%;
          height: 100%;
          padding: var(--spacing-lg);
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md);
        }
        .settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .settings-header h2 {
          margin: 0;
          color: var(--accent-primary);
        }
        .settings-section h3 {
          margin: 0 0 var(--spacing-sm);
          font-size: 13px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .settings-section {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          color: var(--text-secondary);
        }
        input, select {
          background: var(--suggestion-code-bg);
          border: 1px solid var(--border-color);
          border-radius: var(--border-radius-sm);
          color: var(--text-primary);
          padding: var(--spacing-sm);
          font-family: inherit;
        }
        input[type='range'] {
          padding: 0;
        }
        .settings-footer {
          margin-top: auto;
        }
      `}</style>
    </div>
  )
}
