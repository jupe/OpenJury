import Link from "next/link";
import type { ReactNode } from "react";
import MobileNavigation from "@/components/MobileNavigation";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:rounded-xl focus:bg-white focus:p-4">
        Skip to content
      </a>
      <header className="site-header border-b border-slate-200 bg-white">
        <nav aria-label="Main navigation" className="site-nav mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Link href="/" className="flex min-h-12 items-center gap-2 text-xl font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4">
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm text-white">OJ</span>
            <span>OpenJury</span>
          </Link>
          <Link href="/dashboard" className="desktop-dashboard-link flex min-h-12 items-center rounded-xl bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-4">
            Dashboard
          </Link>
        </nav>
      </header>
      <main id="main-content" tabIndex={-1} className="site-main mx-auto max-w-5xl space-y-5">{children}</main>
      <MobileNavigation />
    </div>
  );
}
