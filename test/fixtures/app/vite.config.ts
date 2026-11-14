import path from 'node:path'
import stylex from '@stylexjs/unplugin'
import tailwindcss from '@tailwindcss/vite'
import { rari } from 'rari/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    stylex.vite(),
    rari({
      cacheControl: {
        routes: {
          '/headers-test': 'no-store',
          '/use-cache-revalidate': 'no-store',
          '/server-response': 'public, max-age=60',
          '/server-response-streaming': 'public, max-age=60',
          '/get-data-props/*': 'public, max-age=60',
          '/runtime-health-blocker': 'no-store',
          '/stale-render/source': 'no-store',
          '/stale-render/failure': 'no-store',
        },
      },
      experimental: {
        useCache: true,
        useCacheRemote: {
          handler: 'test',
        },
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
})
