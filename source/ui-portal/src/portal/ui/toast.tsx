import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '@/portal/lib/cn';

export type ToastVariant = 'default' | 'success' | 'error';

export type Toast = {
  id: string;
  title?: string;
  message: string;
  variant?: ToastVariant;
  timeoutMs?: number;
};

type ToastContextValue = {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current[id];
    if (handle) window.clearTimeout(handle);
    delete timers.current[id];
  }, []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const toast: Toast = { id, variant: 'default', timeoutMs: 5000, ...t };
      setToasts((prev) => [toast, ...prev].slice(0, 5));
      const timeoutMs = toast.timeoutMs ?? 5000;
      timers.current[id] = window.setTimeout(() => dismiss(id), timeoutMs);
    },
    [dismiss]
  );

  const clear = useCallback(() => {
    Object.values(timers.current).forEach((h) => window.clearTimeout(h));
    timers.current = {};
    setToasts([]);
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss, clear }), [toasts, push, dismiss, clear]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function Toaster() {
  const { toasts, dismiss } = useToast();

  const styles: Record<ToastVariant, string> = {
    default: 'border-border bg-card text-foreground',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100',
    error: 'border-red-600/30 bg-red-600/10 text-red-200'
  };

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto rounded-lg border p-4 shadow-xl backdrop-blur',
            styles[t.variant ?? 'default']
          )}
          role="status"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {t.title && <div className="text-sm font-semibold">{t.title}</div>}
              <div className={cn('text-sm', t.title ? 'mt-1' : '')}>{t.message}</div>
            </div>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}


