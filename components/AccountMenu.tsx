"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useLocale, type Locale } from "@/lib/i18n";

/** Header account control: shows who is signed in, with navigation and sign-out. */
export default function AccountMenu({ email, signingOut, onSignOut }: {
  email: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const item = "flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm font-semibold";
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={`${t("Account")} (${email})`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-12 cursor-pointer items-center gap-2 rounded-full py-1 pr-3 pl-1 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700">
          {email.charAt(0).toUpperCase() || "?"}
        </span>
        <span aria-hidden className="hidden text-sm font-semibold sm:inline">{t("Account")}</span>
        <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="absolute top-full right-0 z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
          <p className="px-3 py-2 text-sm text-slate-500">
            {t("Signed in as")}
            <span className="block font-semibold break-all text-slate-900">{email}</span>
          </p>
          <Link href="/dashboard" onClick={() => setOpen(false)} className={`${item} text-slate-800 hover:bg-slate-100`}>
            {t("Your groups")}
          </Link>
          <label className="block px-3 py-2 text-sm font-semibold">
            {t("Language")}
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
              className="mt-1 block min-h-11 w-full rounded border border-slate-300 p-2 text-base"
            >
              <option value="en">{t("English")}</option>
              <option value="fi">{t("Finnish")}</option>
            </select>
          </label>
          <button type="button" disabled={signingOut} onClick={onSignOut} className={`${item} text-red-700 hover:bg-red-50 disabled:opacity-50`}>
            {t(signingOut ? "Signing out…" : "Sign out")}
          </button>
        </div>
      )}
    </div>
  );
}
