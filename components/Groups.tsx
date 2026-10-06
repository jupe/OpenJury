"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { CompetitionManager } from "@/components/Competitions";
import { GroupMembers } from "@/components/Membership";
import Breadcrumbs from "@/components/Breadcrumbs";
import AddButton from "@/components/AddButton";
import Button from "@/components/Button";
import IconButton from "@/components/IconButton";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";

type Group = { id: string; name: string };

export function GroupList() {
  const { client, session } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    setGroups([]);
    setAttempt((value) => value + 1);
  }, []);

  useRealtimeUpdates(client, session.user.id, null, refresh);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        // Joins groups that invited this account's email; failures only delay that.
        await client.rpc("claim_group_invites").abortSignal(controller.signal).then(() => undefined, () => undefined);
        if (!active) return;
        const { data, error } = await client.from("groups").select("id,name").order("name").abortSignal(controller.signal);
        if (!active) return;
        if (error) setError(t("Unable to load groups: {error}", { error: t(error.message) }));
        else setGroups(data || []);
      } catch {
        if (active) setError(t("Unable to load groups. Please try again."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, attempt, t]);

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setCreateError("");
    setCreatedId("");
    try {
      const { data, error } = await client.rpc("create_group", { group_name: name.trim() });
      if (!mounted.current) return;
      if (error) setCreateError(t("Unable to create group: {error}", { error: t(error.message) }));
      else if (typeof data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
        setCreateError(t("The server returned an invalid group ID. Refresh your groups before trying again."));
      } else {
        setCreatedId(data);
        setName("");
        dialog.current?.close();
        router.push(`/group/${data}`);
      }
    } catch {
      if (mounted.current) setCreateError(t("Unable to create group. Please try again."));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  function closeDialog() {
    dialog.current?.close();
    setName("");
    setCreateError("");
  }

  return (
    <Card title={t("Groups")} action={<AddButton aria-label={t("New group")} onClick={() => dialog.current?.showModal()} />}>
      {loading ? <p role="status">{t("Loading groups…")}</p> : error ? (
        <><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>{t("Retry groups")}</Button></>
      ) : groups.length ? (
        <table aria-label={t("Groups")} className="w-full table-fixed text-left">
          <thead className="text-sm text-slate-500">
            <tr className="border-b border-slate-200">
              <th scope="col" className="pb-2 font-medium">{t("Group name")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id} className="border-b border-slate-100 last:border-0">
                <td className="break-words py-1 text-slate-900">
                  <Link className="inline-flex min-h-12 max-w-full items-center underline" href={`/group/${group.id}`}>{group.name}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>{t("You do not belong to any groups yet. Open an invite link from a group admin, or create a group with +.")}</p>}
      {createdId && <p role="status">{t("Group created.")} <Link className="underline" href={`/group/${createdId}`}>{t("Open group")}</Link></p>}
      <dialog ref={dialog} aria-labelledby="new-group-title" onClose={() => setCreateError("")} className="app-dialog m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl p-5 shadow-xl">
        <form onSubmit={createGroup} className="space-y-4" aria-busy={creating}>
          <h2 id="new-group-title" className="text-lg font-semibold">{t("New group")}</h2>
          <label className="block">{t("Group name")}
            <input required autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
          </label>
          {createError && <p role="alert">{createError}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={closeDialog} className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">{t("Cancel")}</button>
            <Button type="submit" disabled={creating || !name.trim()}>{t(creating ? "Creating group…" : "Create group")}</Button>
          </div>
        </form>
      </dialog>
    </Card>
  );
}

export function GroupDetails({ id }: { id: string }) {
  const { client, session } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const [group, setGroup] = useState<Group | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    setGroup(null);
    setIsAdmin(false);
    setAttempt((value) => value + 1);
  }, []);

  useRealtimeUpdates(client, session.user.id, id, refresh);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
        const [groupResult, membershipResult] = await Promise.all([
          client.from("groups").select("id,name").eq("id", id).abortSignal(controller.signal).maybeSingle(),
          client.from("group_members").select("role").eq("group_id", id).eq("user_id", session.user.id).abortSignal(controller.signal).maybeSingle(),
        ]);
        if (!active) return;
        if (groupResult.error) setError(t("Unable to load group: {error}", { error: t(groupResult.error.message) }));
        else if (membershipResult.error) setError(t("Unable to check group access: {error}", { error: t(membershipResult.error.message) }));
        else {
          setGroup(groupResult.data);
          setName(groupResult.data?.name ?? "");
          setIsAdmin(membershipResult.data?.role === "admin");
        }
      } catch {
        if (active) setError(t("Unable to load group. Please try again."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, id, session.user.id, attempt, t]);

  async function renameGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !name.trim() || !group) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const { error: rpcError } = await client.rpc("rename_group", {
        p_group_id: group.id,
        p_name: name.trim(),
      });
      if (rpcError) setSaveError(t("Unable to rename group: {error}", { error: t(rpcError.message) }));
      else {
        setGroup({ ...group, name: name.trim() });
        setName(name.trim());
        setSaveMessage(t("Group name updated."));
        setEditing(false);
      }
    } catch {
      setSaveError(t("Unable to rename group. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  function startEditing() {
    setSaveError("");
    setSaveMessage("");
    setEditing(true);
  }

  function cancelEditing() {
    setName(group?.name ?? "");
    setSaveError("");
    setEditing(false);
  }

  function openRemoveDialog() {
    setRemoveError("");
    removeDialog.current?.showModal();
  }

  async function deleteGroup() {
    if (saving || !group) return;
    setSaving(true);
    setRemoveError("");
    try {
      const { error: rpcError } = await client.rpc("delete_group", {
        p_group_id: group.id,
      });
      if (rpcError) setRemoveError(t("Unable to remove group: {error}", { error: t(rpcError.message) }));
      else router.push("/dashboard");
    } catch {
      setRemoveError(t("Unable to remove group. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p role="status">{t("Loading group…")}</p>;
  if (error) return <Card title={t("Group unavailable")}><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setGroup(null); setError(""); setAttempt((value) => value + 1); }}>{t("Retry group")}</Button></Card>;
  if (!group) return <Card title={t("Group not found or access denied")}><p>{t("This group does not exist, or you are not a member.")}</p><Link href="/dashboard" className="underline">{t("Back to your groups")}</Link></Card>;
  return (
    <>
      <Breadcrumbs items={[{ label: t("Dashboard"), href: "/dashboard" }, { label: group.name }]} />
      {isAdmin && (
        <>
          <Card title={t("Group settings")}>
            {editing ? (
              <form onSubmit={renameGroup} onKeyDown={(event) => { if (event.key === "Escape") cancelEditing(); }} className="flex items-center gap-1" aria-busy={saving}>
                <input aria-label={t("Group name")} autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="block min-h-12 min-w-0 flex-1 rounded border border-slate-300 p-2" />
                <IconButton type="submit" icon="save" tone="primary" aria-label={t(saving ? "Saving…" : "Save group name")} disabled={saving || !name.trim() || name.trim() === group.name} />
                <IconButton icon="cancel" aria-label={t("Cancel")} disabled={saving} onClick={cancelEditing} />
              </form>
            ) : (
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 break-words font-semibold text-slate-900">{group.name}</p>
                <IconButton icon="edit" aria-label={t("Rename group")} disabled={saving} onClick={startEditing} />
                <IconButton icon="remove" tone="danger" aria-label={t("Remove group")} disabled={saving} onClick={openRemoveDialog} />
              </div>
            )}
            {saveError && <p role="alert">{saveError}</p>}
            {saveMessage && <p role="status">{saveMessage}</p>}
          </Card>
          <dialog ref={removeDialog} aria-labelledby="remove-group-title" onClose={() => setRemoveError("")} className="app-dialog m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl p-5 shadow-xl">
            <div className="space-y-4" aria-busy={saving}>
              <h2 id="remove-group-title" className="text-lg font-semibold">{t("Remove “{name}”?", { name: group.name })}</h2>
              <p className="text-slate-600">{t("Removing a group permanently deletes its competitions and other group data. Groups with disqualification audit records cannot be removed.")}</p>
              <p className="text-slate-600">{t("This cannot be undone.")}</p>
              {removeError && <p role="alert">{removeError}</p>}
              <div className="flex flex-wrap justify-end gap-3">
                <button type="button" onClick={() => removeDialog.current?.close()} className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">{t("Cancel")}</button>
                <Button className="bg-red-700 hover:bg-red-800 active:bg-red-900" disabled={saving} onClick={deleteGroup}>
                  {t(saving ? "Working…" : "Remove group")}
                </Button>
              </div>
            </div>
          </dialog>
        </>
      )}
      {isAdmin && <GroupMembers groupId={id} />}
      <CompetitionManager groupId={id} />
    </>
  );
}
