"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Breadcrumbs from "@/components/Breadcrumbs";
import Button from "@/components/Button";
import Card from "@/components/Card";
import { failureMessage } from "@/lib/errors";
import { useLocale } from "@/lib/i18n";

/** The signed-in user's own profile: their email and optional display name. */
export function ProfileSettings() {
  const { t } = useLocale();
  const { client, session } = useAuth();
  const savedName = typeof session.user.user_metadata.display_name === "string" ? session.user.user_metadata.display_name.trim() : "";
  const [name, setName] = useState(savedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

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

  return (
    <>
      <Breadcrumbs items={[{ label: t("Dashboard"), href: "/dashboard" }, { label: t("Profile") }]} />
      <Card title={t("Account details")}>
        <dl>
          <dt className="text-sm font-semibold text-slate-900">{t("Email address")}</dt>
          <dd className="break-all">{session.user.email || session.user.id}</dd>
        </dl>
        <form onSubmit={saveName} className="border-t border-slate-100 pt-4" aria-busy={saving}>
          <label htmlFor="profile-name" className="block text-sm font-semibold text-slate-900">{t("Your name")}</label>
          <div className="mt-1 flex flex-wrap gap-2 sm:flex-nowrap">
            <input id="profile-name" autoComplete="nickname" maxLength={100} value={name} disabled={saving}
              aria-describedby="profile-name-hint"
              onChange={(event) => { setName(event.target.value); setSaved(false); }}
              className="block min-h-12 min-w-0 flex-1 rounded border border-slate-300 p-2" />
            <Button type="submit" className="shrink-0" disabled={saving}>{t(saving ? "Saving…" : "Save name")}</Button>
          </div>
          <p id="profile-name-hint" className="mt-1 text-xs text-slate-500">{t("Optional. Shown in lists and published results. Only you can change it.")}</p>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          {saved && <p role="status" className="mt-2 text-sm">{t("Your name has been saved.")}</p>}
        </form>
      </Card>
    </>
  );
}
