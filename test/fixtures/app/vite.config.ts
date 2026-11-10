import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { rari } from 'rari/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    rari({
      cacheControl: {
        routes: {
          '/server-response': 'public, max-age=60',
          '/server-response-delayed': 'public, max-age=60',
          '/server-response-streaming': 'public, max-age=60',
          '/server-response-fallback': 'public, max-age=60',
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
