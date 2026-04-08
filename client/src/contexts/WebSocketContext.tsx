import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';

interface WebSocketContextValue {
  ws: WebSocket | null;
  isConnected: boolean;
}

const WebSocketContext = createContext<WebSocketContextValue>({ ws: null, isConnected: false });

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsInstance = new WebSocket(`${protocol}//${window.location.host}/ws`);

    wsInstance.onopen = () => setIsConnected(true);
    wsInstance.onclose = () => {
      setIsConnected(false);
      // Auto reconnect after 3s
      setTimeout(() => setWs(null), 3000);
    };
    wsInstance.onerror = () => setIsConnected(false);

    setWs(wsInstance);
    return () => wsInstance.close();
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
