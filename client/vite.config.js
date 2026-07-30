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
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // OpenLog 后端
      '/api': {
        target: 'http://localhost:3011',
        changeOrigin: true,
      },
      // WebSocket
      '/ws': {
        target: 'ws://localhost:3011',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
