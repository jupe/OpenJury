"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Breadcrumbs from "@/components/Breadcrumbs";
import Card from "@/components/Card";
import IconButton from "@/components/IconButton";
import PushNotifications from "@/components/PushNotifications";
import { failureMessage } from "@/lib/errors";
import { useLocale } from "@/lib/i18n";

/** The signed-in user's own profile: their email and optional display name. */
export function ProfileSettings() {
  const { t } = useLocale();
  const { client, session } = useAuth();
  const initialName = typeof session.user.user_metadata.display_name === "string" ? session.user.user_metadata.display_name.trim() : "";
  const [savedName, setSavedName] = useState(initialName);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function startEditing() {
    setName(savedName);
    setError("");
    setSaved(false);
    setEditing(true);
  }

  function cancelEditing() {
    setName(savedName);
    setError("");
    setEditing(false);
  }

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
      const updatedName = name.trim();
      setName(updatedName);
      setSavedName(updatedName);
      setSaved(true);
      setEditing(false);
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
        <div className="mt-4 border-t border-slate-100 pt-4">
          {editing ? (
            <form onSubmit={saveName} onKeyDown={(event) => { if (event.key === "Escape" && !saving) cancelEditing(); }} aria-busy={saving}>
              <label htmlFor="profile-name" className="block text-sm font-semibold text-slate-900">{t("Your name")}</label>
              <div className="mt-1 flex gap-2">
                <input id="profile-name" autoComplete="nickname" maxLength={100} value={name} disabled={saving}
                  aria-describedby="profile-name-hint"
                  onChange={(event) => { setName(event.target.value); setSaved(false); }}
                  className="block min-h-12 min-w-0 flex-1 rounded border border-slate-300 p-2" />
                <IconButton type="submit" icon={saving ? "pending" : "save"} tone="primary"
                  aria-label={t(saving ? "Saving…" : "Save name")} disabled={saving} />
                <IconButton icon="cancel" aria-label={t("Cancel edit")} disabled={saving} onClick={cancelEditing} />
              </div>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">{t("Your name")}</p>
                <p className="break-words">{savedName || "—"}</p>
              </div>
              <IconButton icon="edit" aria-label={t("Edit name")} onClick={startEditing} />
            </div>
          )}
          <p id="profile-name-hint" className="mt-1 text-xs text-slate-500">{t("Optional. Shown in lists and published results. Only you can change it.")}</p>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          {saved && <p role="status" className="mt-2 text-sm">{t("Your name has been saved.")}</p>}
        </div>
      </Card>
      <PushNotifications />
    </>
  );
}
