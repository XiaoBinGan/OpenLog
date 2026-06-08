import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  persistent?: boolean; // 不自动消失，手动关闭
  group?: string;       // 同类 toast 去重：同 group 只保留一条
}

interface ToastMsg {
  id: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
  persistent?: boolean;
  group?: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, opts?: ToastOptions) => void;
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  warning: (message: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const iconMap = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap = {
  success: 'border-green-500/30 bg-green-500/10 text-green-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-400',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  warning: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  const addToast = useCallback((type: ToastType, message: string, opts?: ToastOptions) => {
    const action = opts?.action;
    const persistent = opts?.persistent || false;
    const group = opts?.group;

    // 同 group 合并：更新已有 toast 的消息
    if (group) {
      setToasts(prev => {
        const existing = prev.findIndex(t => t.group === group);
        if (existing !== -1) {
          const next = [...prev];
          next[existing] = { ...next[existing], message, action: action || next[existing].action };
          return next;
        }
        const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return [...prev, { id: newId, type, message, action, persistent, group }];
      });
      return;
    }

    // 普通 toast
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev, { id, type, message, action, persistent, group }]);

    if (!persistent) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, action ? 8000 : 3500);
    }
  }, []);

  const success = useCallback((msg: string, opts?: ToastOptions) => addToast('success', msg, opts), [addToast]);
  const error = useCallback((msg: string, opts?: ToastOptions) => addToast('error', msg, opts), [addToast]);
  const info = useCallback((msg: string, opts?: ToastOptions) => addToast('info', msg, opts), [addToast]);
  const warning = useCallback((msg: string, opts?: ToastOptions) => addToast('warning', msg, opts), [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error, info, warning }}>
      {children}
      {/* Toast 容器 */}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col-reverse gap-2 pointer-events-none">
        {toasts.map(t => {
          const Icon = iconMap[t.type];
          return (
            <div
              key={t.id}
              className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-xl animate-slide-in pointer-events-auto group ${colorMap[t.type]}`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{t.message}</span>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.onClick();
                    setToasts(prev => prev.filter(to => to.id !== t.id));
                  }}
                  className="ml-1 px-2.5 py-1 text-xs rounded-lg border border-current/30 hover:bg-white/10 transition-colors font-medium whitespace-nowrap"
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => setToasts(prev => prev.filter(to => to.id !== t.id))}
                className={`ml-1 p-0.5 rounded hover:bg-white/10 transition-colors ${t.persistent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
