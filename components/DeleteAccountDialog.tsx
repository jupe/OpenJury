"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import IconButton from "@/components/IconButton";
import { useLocale } from "@/lib/i18n";

export const demoDeletionMessage = "Account deletion is unavailable in the demo because there is no backend storage to delete.";

export default function DeleteAccountDialog({ account, onCancel, onDeleted }: {
  account: { id: string; email?: string | null; display_name?: string | null };
  onCancel: () => void;
  onDeleted?: () => void;
}) {
  const { client, session, demo } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  async function remove() {
    if (demo || working.current) return;
    working.current = true;
    setPending(true);
    setError("");
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError || !data.session?.access_token) throw new Error("Authentication required");
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { Authorization: ["Bearer", data.session.access_token].join(" "), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: account.id }),
      });
      if (!response.ok) throw new Error("Account deletion failed");
      if (account.id === session.user.id) {
        // Deletion invalidates the server account; clear only this device's session.
        try {
          await client.auth.signOut({ scope: "local" });
        } finally {
          router.replace("/");
          router.refresh();
        }
      } else {
        onDeleted?.();
      }
    } catch {
      setError(t("Unable to delete the account. Please try again."));
      working.current = false;
      setPending(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); if (!working.current) onCancel(); }}
      className="app-dialog m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl p-5 shadow-xl">
      <div className="space-y-4" aria-busy={pending}>
        <h2 id={titleId} className="text-lg font-semibold">{t("Delete account permanently?")}</h2>
        <div className="break-words">
          {account.display_name && <p className="font-semibold">{account.display_name}</p>}
          <p>{account.email || t("No email address")}</p>
        </div>
        <div id={descriptionId} className="space-y-2">
          <p>{t("This cannot be undone. The account and its entries, media, votes, memberships, and invites will be permanently removed.")}</p>
          <p>{t("Shared groups and competitions are retained. A group may be left without an admin; a platform admin can take over its management.")}</p>
        </div>
        {demo && <p role="status">{t(demoDeletionMessage)}</p>}
        {error && <p role="alert">{error}</p>}
        {pending && <p role="status">{t("Deleting account…")}</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="secondary" autoFocus disabled={pending} onClick={onCancel}>{t("Cancel")}</Button>
          <IconButton icon={pending ? "pending" : "remove"} tone="danger"
            aria-label={t("Confirm permanent deletion")} disabled={pending || demo} onClick={() => void remove()} />
        </div>
      </div>
    </dialog>
  );
}
