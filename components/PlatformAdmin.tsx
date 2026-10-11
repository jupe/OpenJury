"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthBoundary";
import { ButtonLink } from "@/components/Button";
import Card from "@/components/Card";
import { Icon } from "@/components/IconButton";
import { useLocale } from "@/lib/i18n";

const PlatformAdminContext = createContext<"checking" | "authorized" | "denied">("checking");

export function PlatformAdminProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth();
  const pathname = usePathname();
  const [verification, setVerification] = useState<{ path: string; authorized: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const controller = new AbortController();
    async function verify() {
      const request = ++revision;
      try {
        const result = await client.rpc("is_platform_admin").abortSignal(controller.signal);
        if (active && request === revision) setVerification({ path: pathname, authorized: !result.error && result.data === true });
      } catch {
        if (active && request === revision) setVerification({ path: pathname, authorized: false });
      }
    }
    void verify();
    const onVisible = () => {
      if (document.visibilityState === "visible") void verify();
    };
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("focus", verify);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, pathname]);

  const status = verification?.path !== pathname ? "checking" : verification.authorized ? "authorized" : "denied";
  return <PlatformAdminContext.Provider value={status}>{children}</PlatformAdminContext.Provider>;
}

export function PlatformAdminBoundary({ children }: { children: ReactNode }) {
  const status = useContext(PlatformAdminContext);
  const { t } = useLocale();
  if (status === "checking") return <p role="status">{t("Checking access…")}</p>;
  if (status !== "authorized") return (
    <Card title={t("Access denied")}>
      <p>{t("Platform administrator access required.")}</p>
      <ButtonLink href="/dashboard">{t("Go to your groups")}</ButtonLink>
    </Card>
  );
  return children;
}

export function PlatformAdminMenu() {
  const status = useContext(PlatformAdminContext);
  const { t } = useLocale();
  const pathname = usePathname();
  const root = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !root.current?.open) return;
      root.current.open = false;
      root.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  if (status !== "authorized") return null;
  return (
    <details ref={root} className="relative">
      <summary aria-label={t("Platform administration")} title={t("Platform administration")}
        className="flex min-h-12 min-w-12 cursor-pointer list-none items-center justify-center gap-2 rounded-full px-3 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <Icon name="admin" className="size-5 text-indigo-700" />
        <span className="hidden text-sm font-semibold sm:inline">{t("Platform administration")}</span>
      </summary>
      <nav aria-label={t("Platform administration")} className="absolute top-full right-0 z-40 mt-2 w-52 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
        {[
          { href: "/platform/groups", label: "Groups" },
          { href: "/platform/users", label: "Users" },
        ].map(({ href, label }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}
            onClick={() => { if (root.current) root.current.open = false; }}
            className="flex min-h-12 items-center rounded-xl px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100">
            {t(label)}
          </Link>
        ))}
      </nav>
    </details>
  );
}
