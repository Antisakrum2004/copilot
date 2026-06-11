import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const root = resolve(__dirname)

const sharedAlias = {
  '@shared': resolve(root, 'src/shared')
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Явно экстернализируем нативный C++ модуль.
        // Без этого Vite пытается упаковать .node бинарник
        // в JS-бандл, что ломает его на этапе выполнения.
        // externalizeDepsPlugin() по умолчанию экстернализирует
        // ВСЕ dependencies из package.json, но мы дублируем
        // здесь для гарантии — если модуль будет перенесён
        // в devDependencies или добавлен динамически.
        exclude: []
      })
    ],
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: resolve(root, 'src/main/index.ts')
      },
      rollupOptions: {
        // Дополнительная гарантия: rollup не пытается
        // встроить нативный модуль в бандл
        external: ['win-audio-capture']
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
