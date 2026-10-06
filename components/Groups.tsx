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
import Card from "@/components/Card";

type Group = { id: string; name: string };

export function GroupList() {
  const { client, session } = useAuth();
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
        if (error) setError(`Unable to load groups: ${error.message}`);
        else setGroups(data || []);
      } catch {
        if (active) setError("Unable to load groups. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, attempt]);

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setCreateError("");
    setCreatedId("");
    try {
      const { data, error } = await client.rpc("create_group", { group_name: name.trim() });
      if (!mounted.current) return;
      if (error) setCreateError(`Unable to create group: ${error.message}`);
      else if (typeof data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
        setCreateError("The server returned an invalid group ID. Refresh your groups before trying again.");
      } else {
        setCreatedId(data);
        setName("");
        dialog.current?.close();
        router.push(`/group/${data}`);
      }
    } catch {
      if (mounted.current) setCreateError("Unable to create group. Please try again.");
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
    <Card title="Groups" action={<AddButton aria-label="New group" onClick={() => dialog.current?.showModal()} />}>
      {loading ? <p role="status">Loading groups…</p> : error ? (
        <><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>Retry groups</Button></>
      ) : groups.length ? (
        <ul className="space-y-2">{groups.map((group) => <li key={group.id}><Link className="break-words underline" href={`/group/${group.id}`}>{group.name}</Link></li>)}</ul>
      ) : <p>You do not belong to any groups yet. Open an invite link from a group admin, or create a group with +.</p>}
      {createdId && <p role="status">Group created. <Link className="underline" href={`/group/${createdId}`}>Open group</Link></p>}
      <dialog ref={dialog} aria-labelledby="new-group-title" onClose={() => setCreateError("")} className="app-dialog m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl p-5 shadow-xl">
        <form onSubmit={createGroup} className="space-y-4" aria-busy={creating}>
          <h2 id="new-group-title" className="text-lg font-semibold">New group</h2>
          <label className="block">Group name
            <input required autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
          </label>
          {createError && <p role="alert">{createError}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={closeDialog} className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">Cancel</button>
            <Button type="submit" disabled={creating || !name.trim()}>{creating ? "Creating group…" : "Create group"}</Button>
          </div>
        </form>
      </dialog>
    </Card>
  );
}

export function GroupDetails({ id }: { id: string }) {
  const { client, session } = useAuth();
  const router = useRouter();
  const [group, setGroup] = useState<Group | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
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
        if (groupResult.error) setError(`Unable to load group: ${groupResult.error.message}`);
        else if (membershipResult.error) setError(`Unable to check group access: ${membershipResult.error.message}`);
        else {
          setGroup(groupResult.data);
          setName(groupResult.data?.name ?? "");
          setIsAdmin(membershipResult.data?.role === "admin");
        }
      } catch {
        if (active) setError("Unable to load group. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, id, session.user.id, attempt]);

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
      if (rpcError) setSaveError(`Unable to rename group: ${rpcError.message}`);
      else {
        setGroup({ ...group, name: name.trim() });
        setName(name.trim());
        setSaveMessage("Group name updated.");
      }
    } catch {
      setSaveError("Unable to rename group. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup() {
    if (saving || !group) return;
    if (!window.confirm(`Remove “${group.name}” and permanently delete its competitions and group data? This cannot be undone.`)) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const { error: rpcError } = await client.rpc("delete_group", {
        p_group_id: group.id,
      });
      if (rpcError) setSaveError(`Unable to remove group: ${rpcError.message}`);
      else router.push("/dashboard");
    } catch {
      setSaveError("Unable to remove group. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p role="status">Loading group…</p>;
  if (error) return <Card title="Group unavailable"><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setGroup(null); setError(""); setAttempt((value) => value + 1); }}>Retry group</Button></Card>;
  if (!group) return <Card title="Group not found or access denied"><p>This group does not exist, or you are not a member.</p><Link href="/dashboard" className="underline">Back to your groups</Link></Card>;
  return (
    <>
      <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: group.name }]} />
      {isAdmin && (
        <Card title="Group settings">
          <form onSubmit={renameGroup} className="space-y-4" aria-busy={saving}>
            <label className="block">Group name
              <input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button type="submit" disabled={saving || !name.trim() || name.trim() === group.name}>
              {saving ? "Saving…" : "Rename group"}
            </Button>
          </form>
          <div className="mt-6 border-t border-slate-200 pt-4">
            <Button className="bg-red-700 hover:bg-red-800 active:bg-red-900" disabled={saving} onClick={deleteGroup}>
              {saving ? "Working…" : "Remove group"}
            </Button>
            <p className="mt-2 text-sm">Removing a group permanently deletes its competitions and other group data. Groups with disqualification audit records cannot be removed.</p>
          </div>
          {saveError && <p role="alert" className="mt-4">{saveError}</p>}
          {saveMessage && <p role="status" className="mt-4">{saveMessage}</p>}
        </Card>
      )}
      {isAdmin && <GroupMembers groupId={id} />}
      <CompetitionManager groupId={id} />
    </>
  );
}
