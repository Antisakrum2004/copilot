import { useCallback, useState } from 'react'
import { SettingsPanel } from './components/SettingsPanel'
import { SuggestionPanel } from './components/SuggestionPanel'
import { Toolbar } from './components/Toolbar'
import { TranscriptPanel } from './components/TranscriptPanel'

type Route = 'toolbar' | 'suggestion' | 'transcript'

function getRouteFromHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash === 'suggestion' || hash === 'transcript') return hash
  return 'toolbar'
}

export default function App() {
  const [route] = useState<Route>(getRouteFromHash)
  const [recording, setRecording] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ВАЖНО: НЕ вызываем setIgnoreMouseEvents здесь!
  // Каждое окно управляет своим mouse-поведением:
  //   - toolbar: всегда кликабельный (настраивается в main процессе)
  //   - suggestion/transcript: dynamic passthrough через DOM-события
  //     в самих компонентах (mouseenter → clickable, mouseleave → click-through)

  const toggleRecording = useCallback(async () => {
    if (recording) {
      await window.copilot.audio.stopStreams()
      await window.copilot.audio.stopNativeLoopback()
      setRecording(false)
    } else {
      // Запускаем захват: микрофон + системный звук (loopback)
      await window.copilot.audio.startStreams()
      await window.copilot.audio.startNativeLoopback()
      setRecording(true)
    }
  }, [recording])

  if (settingsOpen && route === 'toolbar') {
    return <SettingsPanel onClose={() => setSettingsOpen(false)} />
  }

  switch (route) {
    case 'suggestion':
      return <SuggestionPanel />
    case 'transcript':
      return <TranscriptPanel />
    default:
      return (
        <Toolbar
          recording={recording}
          onToggleRecording={() => void toggleRecording()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )
  }
}
