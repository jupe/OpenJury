"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import Button from "@/components/Button";
import { failureMessage } from "@/lib/errors";
import { useLocale, type Locale } from "@/lib/i18n";

/** Header account control: shows who is signed in, with navigation and sign-out. */
export default function AccountMenu({ client, displayName, email, signingOut, onSignOut }: {
  client: SupabaseClient;
  displayName: string;
  email: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
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

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const { error: updateError } = await client.auth.updateUser({
        data: { display_name: name.trim() || null },
      });
      if (updateError) throw updateError;
      setName(name.trim());
      setSaved(true);
    } catch (failure) {
      setError(t("Unable to save your name: {error}", { error: t(failureMessage(failure)) }));
    } finally {
      setSaving(false);
    }
  }

  const item = "flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm font-semibold";
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={`${t("Account")} (${email})`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) {
            setName(displayName);
            setError("");
            setSaved(false);
          }
          setOpen((value) => !value);
        }}
        className="flex min-h-12 cursor-pointer items-center gap-2 rounded-full py-1 pr-3 pl-1 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700">
          {(displayName || email).charAt(0).toUpperCase() || "?"}
        </span>
        <span aria-hidden className="hidden text-sm font-semibold sm:inline">{t("Account")}</span>
        <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="absolute top-full right-0 z-40 mt-2 max-h-[calc(100dvh-6rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
          <p className="px-3 py-2 text-sm text-slate-500">
            {t("Signed in as")}
            {displayName && <span className="block font-semibold break-words text-slate-900">{displayName}</span>}
            <span className="block break-all text-slate-900">{email}</span>
          </p>
          <form onSubmit={saveName} className="space-y-2 px-3 py-2" aria-busy={saving}>
            <label className="block text-sm font-semibold">
              {t("Your name")}
              <input autoComplete="nickname" maxLength={100} value={name} disabled={saving}
                onChange={(event) => { setName(event.target.value); setSaved(false); }}
                className="mt-1 block min-h-11 w-full rounded border border-slate-300 p-2 text-base" />
            </label>
            <p className="text-sm text-slate-500">{t("Optional. Shown in lists and published results. Only you can change it.")}</p>
            <Button type="submit" disabled={saving || signingOut}>{t(saving ? "Saving…" : "Save name")}</Button>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {saved && <p role="status" className="text-sm">{t("Your name has been saved.")}</p>}
          </form>
          <Link href="/dashboard" onClick={() => setOpen(false)} className={`${item} text-slate-800 hover:bg-slate-100`}>
            {t("Your groups")}
          </Link>
          <label className="block px-3 py-2 text-sm font-semibold">
            {t("Language")}
            <select
              aria-label={t("Language")}
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
