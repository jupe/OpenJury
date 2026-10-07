"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import IconButton, { Icon } from "@/components/IconButton";
import { useLocale, type Locale } from "@/lib/i18n";

/** Header account control: who is signed in, a link to their profile, language, and sign-out. */
export default function AccountMenu({ displayName, email, signingOut, onSignOut }: {
  displayName: string;
  email: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const initial = (displayName || email).charAt(0).toUpperCase() || "?";

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
          {initial}
        </span>
        <span aria-hidden className="hidden text-sm font-semibold sm:inline">{t("Account")}</span>
        <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="absolute top-full right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="flex items-center gap-3 px-2 py-2">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700">
              {initial}
            </span>
            <p className="min-w-0 flex-1 text-sm">
              <span className="sr-only">{t("Signed in as")} </span>
              {displayName && <span className="block truncate font-semibold text-slate-900">{displayName}</span>}
              <span className={`block truncate ${displayName ? "text-slate-500" : "font-semibold text-slate-900"}`} title={email}>{email}</span>
            </p>
            <IconButton icon="signOut" tone="danger" disabled={signingOut} aria-label={t(signingOut ? "Signing out…" : "Sign out")} onClick={onSignOut} />
          </div>
          <div className="mt-1 border-t border-slate-100 pt-1">
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100"
            >
              <Icon name="member" className="size-5 text-slate-500" />
              <span className="flex-1">{t("Profile")}</span>
              <Icon name="chevronRight" className="size-4 text-slate-400" />
            </Link>
            <label className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-slate-800">
              <Icon name="globe" className="size-5 text-slate-500" />
              <span className="flex-1">{t("Language")}</span>
              <select
                aria-label={t("Language")}
                value={locale}
                onChange={(event) => setLocale(event.target.value as Locale)}
                className="min-h-11 w-auto cursor-pointer rounded-lg border-slate-200 py-1 pr-7 pl-2 font-normal"
              >
                <option value="en">{t("English")}</option>
                <option value="fi">{t("Finnish")}</option>
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
