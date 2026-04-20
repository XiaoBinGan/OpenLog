import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // DocMind 后端（精确匹配优先，必须在前面）
      '/api/docmind': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/docmind/, '/api'),
      },
      // OpenLog 后端（Go）
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // WebSocket
      '/ws': {
        target: 'ws://localhost:3002',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
