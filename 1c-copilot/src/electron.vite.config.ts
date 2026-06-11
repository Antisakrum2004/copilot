import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const root = resolve(__dirname)

const sharedAlias = {
  '@shared': resolve(root, 'src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: resolve(root, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: resolve(root, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(root, 'src/renderer/src'),
        ...sharedAlias
      }
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: []
      }
    },
    server: {
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**']
      }
    }
  }
})
