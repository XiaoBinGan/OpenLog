import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { bootstrapAuth, whenTokenReady } from './api/auth'
import AuthGate from './components/AuthGate'

const root = ReactDOM.createRoot(document.getElementById('root')!)

// Install the fetch interceptor synchronously, then wait for the token before the
// first render. Without this, components mount and call withWsToken() while
// `GET /api/auth/token` is still in flight, so the very first WebSocket is sent
// without `?token=` and the server answers 401 — on every cold load.
//
// `whenTokenReady()` is internally bounded (TOKEN_FETCH_TIMEOUT_MS in api/auth.ts),
// so awaiting the REAL resolution cannot hang the app. Do not reintroduce a
// Promise.race with a short budget: that renders before the token arrives and
// leaves sockets opened in that window unauthenticated.
async function start() {
  bootstrapAuth()
  try {
    await whenTokenReady()
  } catch {
    // Token resolution failed (offline / not on localhost). Render anyway; the
    // app falls back to the dev loopback bypass or surfaces a 401 once.
  }
  root.render(
    <React.StrictMode>
      {/* 生产模式下远端浏览器拿不到自动令牌，AuthGate 负责要求用户输入一次 */}
      <AuthGate>
        <App />
      </AuthGate>
    </React.StrictMode>,
  )
}

void start()
