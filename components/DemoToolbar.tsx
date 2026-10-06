"use client";

import { useEffect, useState } from "react";
import { personas } from "@/lib/demo/personas";

const deploymentGuide = "https://github.com/jupe/OpenJury/blob/main/docs/deployment.md";

/** Always-visible demo controls: who you are viewing as, and reset. */
export default function DemoToolbar({ userId }: { userId: string | null }) {
  const [resetting, setResetting] = useState(false);
  const known = personas.some((persona) => persona.id === userId);

  useEffect(() => {
    document.documentElement.classList.add("demo-mode");
    return () => document.documentElement.classList.remove("demo-mode");
  }, []);

  async function switchTo(id: string) {
    (await import("@/lib/demo/client")).switchDemoPersona(id);
  }

  async function reset() {
    if (!window.confirm("Delete everything you changed in the demo and start over?")) return;
    setResetting(true);
    await (await import("@/lib/demo/client")).resetDemo();
  }

  return (
    <aside aria-label="Demo mode" className="demo-toolbar text-sm text-white">
      <a
        href={deploymentGuide}
        title="Supabase is not configured, so OpenJury runs on fictional data saved in this browser. See deployment.md."
        className="shrink-0 rounded-md bg-amber-400 px-2 py-1 text-xs font-bold tracking-wider text-amber-950"
      >
        DEMO
      </a>
      <label className="flex shrink-0 items-center gap-2">
        <span className="hidden sm:inline">Viewing as</span>
        <select
          aria-label="Viewing as"
          value={known ? userId! : ""}
          onChange={(event) => void switchTo(event.target.value)}
          className="min-h-11 max-w-48 rounded-lg border border-white/20 bg-slate-800 px-2 text-white"
        >
          {!known && <option value="" disabled>{userId ? "Your new account" : "Signed out"}</option>}
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>{persona.name} · {persona.description}</option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void reset()} disabled={resetting} className="ml-auto flex min-h-11 shrink-0 cursor-pointer items-center rounded-lg px-3 font-semibold hover:bg-white/10 disabled:opacity-50">
        {resetting ? "Resetting…" : "Reset"}
      </button>
    </aside>
  );
}
