import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/atcstream': {
        target: 'https://d.liveatc.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/atcstream/, '/kaus3_app_dep'),
        secure: false,
      },
    },
  },
})
