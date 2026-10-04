"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import Card from "@/components/Card";

type Group = { id: string; name: string };

export function GroupList() {
  const { client } = useAuth();
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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
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
        router.push(`/group/${data}`);
      }
    } catch {
      if (mounted.current) setCreateError("Unable to create group. Please try again.");
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  return (
    <>
      <Card title="Your memberships">
        {loading ? <p role="status">Loading groups…</p> : error ? (
          <><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>Retry groups</Button></>
        ) : groups.length ? (
          <ul className="space-y-2">{groups.map((group) => <li key={group.id}><Link className="break-words underline" href={`/group/${group.id}`}>{group.name}</Link></li>)}</ul>
        ) : <p>You do not belong to any groups yet. Create your first group below.</p>}
      </Card>
      <Card title="Build your community">
        <form onSubmit={createGroup} className="space-y-4" aria-busy={creating}>
          <label className="block">Group name
            <input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
          </label>
          <Button type="submit" disabled={creating || !name.trim()}>{creating ? "Creating group…" : "Create group"}</Button>
        </form>
        {createError && <p role="alert">{createError}</p>}
        {creating && <p role="status">Creating your group…</p>}
        {createdId && <p role="status">Group created. <Link className="underline" href={`/group/${createdId}`}>Open group</Link></p>}
      </Card>
    </>
  );
}

export function GroupDetails({ id }: { id: string }) {
  const { client } = useAuth();
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
        const { data, error } = await client.from("groups").select("id,name").eq("id", id).abortSignal(controller.signal).maybeSingle();
        if (!active) return;
        if (error) setError(`Unable to load group: ${error.message}`);
        else setGroup(data);
      } catch {
        if (active) setError("Unable to load group. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, id, attempt]);

  if (loading) return <p role="status">Loading group…</p>;
  if (error) return <Card title="Group unavailable"><p role="alert">{error}</p><Button onClick={() => { setLoading(true); setGroup(null); setError(""); setAttempt((value) => value + 1); }}>Retry group</Button></Card>;
  if (!group) return <Card title="Group not found or access denied"><p>This group does not exist, or you are not a member.</p><Link href="/dashboard" className="underline">Back to your groups</Link></Card>;
  return (
    <>
      <Card title={group.name}><p>Group: {group.id}</p></Card>
      <Card title="Competitions"><p>Group competitions are not available yet. Submission, voting, and administration remain closed.</p></Card>
    </>
  );
}
