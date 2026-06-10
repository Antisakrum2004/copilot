import Store from 'electron-store'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc'

const store = new Store<AppSettings>({
  name: 'settings',
  defaults: DEFAULT_SETTINGS
})

export function getAllSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.store }
}

export function saveSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): AppSettings {
  store.set(key, value)
  return getAllSettings()
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return store.get(key, DEFAULT_SETTINGS[key])
}
