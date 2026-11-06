import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { withWsToken, whenTokenReady, wsProtocols } from '../api/auth';

interface WebSocketContextValue {
  ws: WebSocket | null;
  isConnected: boolean;
}

const WebSocketContext = createContext<WebSocketContextValue>({ ws: null, isConnected: false });

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // Per-invocation state. Do NOT hoist these into refs: React StrictMode runs
    // this effect twice, and a shared flag would let the first invocation's
    // pending `await` resume after cleanup and open a second socket.
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (cancelled) return;

      // Wait for the token before opening. withWsToken() is synchronous and
      // returns the URL unchanged while the token is still unresolved, which
      // would make the server answer 401.
      try {
        await whenTokenReady();
      } catch {
        // Fall through: connect without a token and let onclose retry.
      }
      if (cancelled) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(withWsToken(`${protocol}//${window.location.host}/ws`), wsProtocols());

      socket.onopen = () => {
        attempt = 0;
        setIsConnected(true);
      };
      socket.onerror = () => setIsConnected(false);
      socket.onclose = () => {
        setIsConnected(false);
        if (cancelled) return;
        // Exponential backoff, capped. The previous implementation called
        // setWs(null) with an empty dependency array, so the effect never
        // re-ran and a single failed handshake killed /ws for the whole session.
        const delay = Math.min(1000 * 2 ** attempt, 15000);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };

      setWs(socket);
    };

    void connect();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ ws, isConnected }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}

// Hook: listen to specific WS message types
export function useWsMessage<T = any>(type: string, handler: (data: T) => void) {
  const { ws } = useWebSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!ws) return;
    const listener = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === type) handlerRef.current(data);
      } catch {}
    };
    ws.addEventListener('message', listener);
    return () => ws.removeEventListener('message', listener);
  }, [ws, type]);
}
