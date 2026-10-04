import Link from "next/link";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <nav aria-label="Main navigation" className="mx-auto flex max-w-5xl items-center justify-between p-6">
          <Link href="/" className="text-xl font-bold focus-visible:outline-2 focus-visible:outline-offset-4">
            OpenJury
          </Link>
          <Link href="/dashboard" className="text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4">
            Dashboard
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-12">{children}</main>
    </div>
  );
}
