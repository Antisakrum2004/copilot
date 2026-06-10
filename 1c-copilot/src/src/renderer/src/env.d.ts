/// <reference types="vite/client" />

import type { CopilotApi } from '../../preload/index'

declare global {
  interface Window {
    copilot: CopilotApi
  }
}

export {}
