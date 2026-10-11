"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import Card from "@/components/Card";
import DeleteAccountDialog, { demoDeletionMessage } from "@/components/DeleteAccountDialog";
import IconButton from "@/components/IconButton";
import { useLocale } from "@/lib/i18n";

type PlatformUser = {
  id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_active_at: string | null;
  groups: { id: string; name: string; role: "admin" | "member" }[];
};

const pageSize = 100;

export default function PlatformUsers() {
  const { client, demo, session } = useAuth();
  const { t, formatDateTime } = useLocale();
  const [authorized, setAuthorized] = useState(false);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlatformUser | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let adminVerified = false;
    void (async () => {
      try {
        const admin = await client.rpc("is_platform_admin").abortSignal(controller.signal);
        if (!active) return;
        if (admin.error || admin.data !== true) {
          setAuthorized(false);
          setUsers([]);
          setSelected(null);
          return;
        }
        adminVerified = true;
        setAuthorized(true);
        const result = await client.rpc("get_platform_users", { p_offset: offset }).abortSignal(controller.signal);
        if (!active) return;
        if (result.error || !Array.isArray(result.data)) throw new Error("Users unavailable");
        setUsers(result.data as PlatformUser[]);
      } catch {
        if (active) {
          if (!adminVerified) {
            setAuthorized(false);
            setUsers([]);
            setSelected(null);
          }
          setError(t("Unable to load users. Please try again."));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, session.user.id, session.access_token, offset, attempt, t]);

  function refresh(nextOffset = offset) {
    setLoading(true);
    setError("");
    setUsers([]);
    setOffset(nextOffset);
    setAttempt((value) => value + 1);
  }

  if (!authorized) return null;
  return (
    <Card title={t("All users (platform admin)")}>
      {demo && <p>{t(demoDeletionMessage)}</p>}
      {loading ? <p role="status">{t("Loading users…")}</p> : error ? (
        <><p role="alert">{error}</p><Button onClick={() => refresh()}>{t("Retry users")}</Button></>
      ) : users.length ? (
        <table aria-label={t("All users (platform admin)")} className="w-full table-fixed text-left">
          <thead className="text-sm text-slate-500">
            <tr className="border-b border-slate-200">
              <th scope="col" className="pb-2 font-medium">{t("Name / email")}</th>
              <th scope="col" className="w-12 pb-2"><span className="sr-only">{t("Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-slate-100 last:border-0">
                <td className="break-words py-3 pr-2">
                  {user.display_name && <p className="font-semibold text-slate-900">{user.display_name}</p>}
                  <p>{user.email || t("No email address")}</p>
                  <dl className="mt-2 space-y-1 text-sm">
                    <div><dt className="inline font-medium">{t("Created")}: </dt><dd className="inline"><time dateTime={user.created_at}>{formatDateTime(user.created_at)}</time></dd></div>
                    <div><dt className="inline font-medium">{t("Last active")}: </dt><dd className="inline">{user.last_active_at ? <time dateTime={user.last_active_at}>{formatDateTime(user.last_active_at)}</time> : t("No activity recorded")}</dd></div>
                  </dl>
                  {user.groups.length ? <ul aria-label={t("Group memberships")} className="mt-2 text-sm">
                    {user.groups.map((group) => <li key={group.id}>{group.name} · {t(group.role === "admin" ? "Admin" : "Member")}</li>)}
                  </ul> : <p className="mt-2 text-sm">{t("No group memberships")}</p>}
                </td>
                <td className="py-3 align-top text-right">
                  <IconButton icon="remove" tone="danger" disabled={demo}
                    aria-label={t("Delete account for {name}", { name: user.display_name || user.email || t("Unnamed account") })}
                    onClick={() => setSelected(user)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>{t("No users on this page.")}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" disabled={loading || offset === 0} onClick={() => refresh(Math.max(0, offset - pageSize))}>{t("Previous users")}</Button>
        <span>{t("Page {page}", { page: offset / pageSize + 1 })}</span>
        <Button variant="secondary" disabled={loading || !!error || users.length < pageSize} onClick={() => refresh(offset + pageSize)}>{t("Next users")}</Button>
      </div>
      {selected && <DeleteAccountDialog account={selected} onCancel={() => setSelected(null)} onDeleted={() => { setSelected(null); refresh(); }} />}
    </Card>
  );
}
