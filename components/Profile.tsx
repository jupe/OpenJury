"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Breadcrumbs from "@/components/Breadcrumbs";
import Card from "@/components/Card";
import IconButton from "@/components/IconButton";
import PushNotifications from "@/components/PushNotifications";
import Button from "@/components/Button";
import { failureMessage } from "@/lib/errors";
import { useLocale } from "@/lib/i18n";
import { getEnabledSocialProviders, type SocialProvider } from "@/lib/supabase";

/** The signed-in user's own profile: their email and optional display name. */
export function ProfileSettings() {
  const { t } = useLocale();
  const { client, session, demo } = useAuth();
  const initialName = typeof session.user.user_metadata.display_name === "string" ? session.user.user_metadata.display_name.trim() : "";
  const [savedName, setSavedName] = useState(initialName);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const providers = demo ? [] : getEnabledSocialProviders();

  async function linkProvider(provider: SocialProvider) {
    if (linking || !providers.some(({ id }) => id === provider.id)) return;
    setLinking(true);
    setLinkError("");
    try {
      const { error } = await client.auth.linkIdentity({
        provider: provider.id,
        options: { redirectTo: `${window.location.origin}/profile` },
      });
      if (error) throw error;
    } catch (failure) {
      setLinkError(t("Unable to link {provider}: {error}", { provider: provider.name, error: t(failureMessage(failure)) }));
      setLinking(false);
    }
  }

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
      {providers.length > 0 && (
        <Card title={t("Linked sign-in services")}>
          <p>{t("Link another service while signed in to keep your groups, entries, and votes in this account, even if its email is different.")}</p>
          <ul className="space-y-3">
            {providers.map((provider) => {
              const linked = session.user.identities?.some((identity) => identity.provider === provider.id) === true;
              return <li key={provider.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{provider.name}</span>
                {linked ? <span>{t("Linked")}</span> : (
                  <Button disabled={linking} onClick={() => linkProvider(provider)}>
                    {t("Link {provider}", { provider: provider.name })}
                  </Button>
                )}
              </li>;
            })}
          </ul>
          {linking && <p role="status">{t("Redirecting to sign-in…")}</p>}
          {linkError && <p role="alert">{linkError}</p>}
        </Card>
      )}
    </>
  );
}
