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
      // OpenLog 后端
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // WebSocket
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
