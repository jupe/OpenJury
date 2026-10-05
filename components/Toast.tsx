"use client";

import { useEffect } from "react";

export type ToastMessage = { id: number; text: string; tone: "success" | "error" };

/** A short-lived notice above the bottom bars. A new message (new id) restarts the timer. */
export default function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, toast.tone === "error" ? 5000 : 2200);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);

  return (
    <div role="status" aria-live="polite" className="toast-region">
      {toast && (
        <p
          key={toast.id}
          className={`toast flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg ${
            toast.tone === "error" ? "bg-red-700 text-white" : "bg-slate-900 text-white"}`}
        >
          {toast.tone === "success" && <span aria-hidden className="text-emerald-400">✓</span>}
          {toast.text}
        </p>
      )}
    </div>
  );
}
