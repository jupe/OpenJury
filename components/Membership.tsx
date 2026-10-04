"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { failureMessage } from "@/lib/errors";
import Button, { ButtonLink } from "@/components/Button";
import Card from "@/components/Card";

// Sign-in links always return to /dashboard, so an invite opened while signed
// out is remembered here and resumed from the dashboard.
const PENDING_INVITE_KEY = "openjury:pending-invite";
const INVITE_TOKEN = /^[0-9a-f]{64}$/;

function readPendingInvite() {
  try {
    return window.localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

function writePendingInvite(token: string | null) {
  try {
    if (token) window.localStorage.setItem(PENDING_INVITE_KEY, token);
    else window.localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Without storage the invite link simply has to be opened again.
  }
}

export function RememberInvite({ token }: { token: string }) {
  useEffect(() => {
    if (INVITE_TOKEN.test(token)) writePendingInvite(token);
  }, [token]);
  return null;
}

/** Sends a member who signed in from an invite link back to that invite. */
export function ResumePendingInvite() {
  const router = useRouter();
  useEffect(() => {
    const token = readPendingInvite();
    if (token && INVITE_TOKEN.test(token)) router.replace(`/invite/${token}`);
    else if (token) writePendingInvite(null);
  }, [router]);
  return null;
}

type InviteDetails = { group_id: string; group_name: string; is_member: boolean };

export function InviteAcceptance({ token }: { token: string }) {
  const { client } = useAuth();
  const router = useRouter();
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    writePendingInvite(null);
    let active = true;
    void (async () => {
      try {
        if (!INVITE_TOKEN.test(token)) return;
        const { data, error: inviteError } = await client.rpc("get_group_invite", { p_token: token });
        if (!active) return;
        if (inviteError) setError(`Unable to open this invite: ${inviteError.message}`);
        else setInvite(((data || []) as InviteDetails[])[0] || null);
      } catch {
        if (active) setError("Unable to open this invite. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, token]);

  async function join() {
    if (joining) return;
    setJoining(true);
    setError("");
    try {
      const { data, error: joinError } = await client.rpc("accept_group_invite", { p_token: token });
      if (joinError) throw joinError;
      router.push(`/group/${encodeURIComponent(String(data))}`);
    } catch (failure) {
      setError(`Unable to join the group: ${failureMessage(failure)}`);
      setJoining(false);
    }
  }

  if (loading) return <p role="status">Opening invite…</p>;
  if (!invite) {
    return (
      <Card title="Invite unavailable">
        {error ? <p role="alert">{error}</p> : <p>This invite link is invalid or has been revoked. Ask a group admin for a new one.</p>}
        <ButtonLink href="/dashboard">Go to your groups</ButtonLink>
      </Card>
    );
  }
  if (invite.is_member) {
    return (
      <Card title={invite.group_name}>
        <p>You are already a member of this group.</p>
        <ButtonLink href={`/group/${encodeURIComponent(invite.group_id)}`}>Open group</ButtonLink>
      </Card>
    );
  }
  return (
    <Card title={`Join ${invite.group_name}`}>
      <p>You have been invited to this group. After joining, you can take part in its competitions as a participant or as audience.</p>
      {error && <p role="alert">{error}</p>}
      <Button disabled={joining} onClick={() => void join()}>{joining ? "Joining…" : "Join group"}</Button>
    </Card>
  );
}

type Member = { user_id: string; email: string; role: "admin" | "member" };
type EmailInvite = { email: string; created_at: string };
type InviteLink = { id: string; token: string; created_at: string };

export function GroupMembers({ groupId }: { groupId: string }) {
  const { client, session } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [emailInvites, setEmailInvites] = useState<EmailInvite[]>([]);
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [working, setWorking] = useState("");
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useRealtimeUpdates(client, session.user.id, groupId, refresh);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [memberResult, emailResult, linkResult] = await Promise.all([
          client.rpc("get_group_members", { p_group_id: groupId }),
          client.rpc("get_group_email_invites", { p_group_id: groupId }),
          client.rpc("get_group_invite_links", { p_group_id: groupId }),
        ]);
        if (!active) return;
        const failure = memberResult.error || emailResult.error || linkResult.error;
        if (failure) {
          setError(`Unable to load members: ${failure.message}`);
          return;
        }
        setError("");
        setMembers((memberResult.data || []) as Member[]);
        setEmailInvites((emailResult.data || []) as EmailInvite[]);
        setLinks((linkResult.data || []) as InviteLink[]);
      } catch {
        if (active) setError("Unable to load members. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, groupId, attempt]);

  async function act(key: string, label: string, run: () => PromiseLike<{ error: unknown }>) {
    if (working) return;
    setWorking(key);
    setActionError("");
    try {
      const { error: rpcError } = await run();
      if (rpcError) throw rpcError;
      refresh();
    } catch (failure) {
      setActionError(`Unable to ${label}: ${failureMessage(failure)}`);
    } finally {
      setWorking("");
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    await act("invite", "invite member", () =>
      client.rpc("invite_group_member_by_email", { p_group_id: groupId, p_email: address }));
    setEmail("");
  }

  async function copy(link: InviteLink) {
    try {
      await navigator.clipboard.writeText(inviteUrl(link.token));
      setCopied(link.id);
    } catch {
      setActionError("Unable to copy automatically. Select the link and copy it instead.");
    }
  }

  const adminCount = members.filter((member) => member.role === "admin").length;
  const inviteUrl = (token: string) => `${window.location.origin}/invite/${token}`;

  if (loading) return <p role="status">Loading members…</p>;
  if (error) return <Card title="Members"><p role="alert">{error}</p><Button onClick={refresh}>Retry members</Button></Card>;

  return (
    <Card title="Members">
      <ul className="space-y-3">
        {members.map((member) => {
          const self = member.user_id === session.user.id;
          const lastAdmin = member.role === "admin" && adminCount === 1;
          return (
            <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
              <div className="min-w-0">
                <p className="break-all font-semibold text-slate-900">{member.email}{self && " (you)"}</p>
                <p className="text-sm">{member.role === "admin" ? "Group admin" : "Member"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {member.role === "member" ? (
                  <Button disabled={!!working} aria-label={`Make ${member.email} a group admin`} onClick={() => void act(member.user_id, "change role", () =>
                    client.rpc("set_group_member_role", { p_group_id: groupId, p_user_id: member.user_id, p_role: "admin" }))}>
                    Make admin
                  </Button>
                ) : (
                  <Button disabled={!!working || lastAdmin} aria-label={`Remove group admin role from ${member.email}`} onClick={() => {
                    if (self && !window.confirm("Stop being a group admin? You will lose access to group management.")) return;
                    void act(member.user_id, "change role", () =>
                      client.rpc("set_group_member_role", { p_group_id: groupId, p_user_id: member.user_id, p_role: "member" }));
                  }}>
                    Remove admin
                  </Button>
                )}
                {!self && (
                  <Button className="bg-red-700 hover:bg-red-800 active:bg-red-900" disabled={!!working || lastAdmin} aria-label={`Remove ${member.email} from the group`} onClick={() => {
                    if (!window.confirm(`Remove ${member.email} from this group?`)) return;
                    void act(member.user_id, "remove member", () =>
                      client.rpc("remove_group_member", { p_group_id: groupId, p_user_id: member.user_id }));
                  }}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {adminCount === 1 && <p className="text-sm">A group needs at least one admin, so make someone else an admin before removing the last one.</p>}

      <form onSubmit={invite} className="space-y-3 border-t border-slate-200 pt-4" aria-busy={working === "invite"}>
        <h3 className="font-semibold text-slate-900">Invite by email</h3>
        <label className="block">Email address
          <input type="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
        </label>
        <p className="text-sm">No email is sent. They join when they next sign in with this address, so let them know.</p>
        <Button type="submit" disabled={!!working || !email.trim()}>{working === "invite" ? "Inviting…" : "Invite"}</Button>
      </form>
      {emailInvites.length > 0 && (
        <ul className="space-y-2">
          {emailInvites.map((pending) => (
            <li key={pending.email} className="flex flex-wrap items-center justify-between gap-3">
              <span className="break-all">{pending.email} · waiting to sign in</span>
              <Button disabled={!!working} aria-label={`Cancel invite for ${pending.email}`} onClick={() => void act(pending.email, "cancel invite", () =>
                client.rpc("revoke_group_email_invite", { p_group_id: groupId, p_email: pending.email }))}>
                Cancel invite
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 border-t border-slate-200 pt-4">
        <h3 className="font-semibold text-slate-900">Invite links</h3>
        <p className="text-sm">Anyone signed in who opens a link joins the group as a member. Revoke a link to stop it working.</p>
        {links.map((link) => (
          <div key={link.id} className="space-y-2 rounded-xl border border-slate-200 p-3">
            <label className="block">Invite link
              <input readOnly value={inviteUrl(link.token)} onFocus={(event) => event.target.select()} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void copy(link)}>{copied === link.id ? "Copied" : "Copy link"}</Button>
              <Button className="bg-red-700 hover:bg-red-800 active:bg-red-900" disabled={!!working} onClick={() => {
                if (!window.confirm("Revoke this invite link? People who have not joined yet can no longer use it.")) return;
                void act(link.id, "revoke link", () => client.rpc("revoke_group_invite", { p_invite_id: link.id }));
              }}>
                Revoke link
              </Button>
            </div>
          </div>
        ))}
        <Button disabled={!!working} onClick={() => void act("link", "create invite link", () =>
          client.rpc("create_group_invite", { p_group_id: groupId }))}>
          {working === "link" ? "Creating…" : "Create invite link"}
        </Button>
      </div>
      {actionError && <p role="alert">{actionError}</p>}
    </Card>
  );
}

type PlatformGroup = { id: string; name: string; member_count: number; admin_count: number; my_role: string | null };

/** Every group, for platform admins configured by the deployment. */
export function PlatformGroups() {
  const { client } = useAuth();
  const router = useRouter();
  const [groups, setGroups] = useState<PlatformGroup[] | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data: isPlatformAdmin } = await client.rpc("is_platform_admin");
        if (!active || isPlatformAdmin !== true) return;
        const { data, error: listError } = await client.rpc("get_platform_groups");
        if (!active) return;
        if (listError) setError(`Unable to load all groups: ${listError.message}`);
        else setGroups((data || []) as PlatformGroup[]);
      } catch {
        // Not a platform admin, or the check is unavailable: show nothing.
      }
    })();
    return () => { active = false; };
  }, [client]);

  async function manage(group: PlatformGroup) {
    if (working || !window.confirm(`Become a group admin of “${group.name}”? Its members will see you in the member list.`)) return;
    setWorking(group.id);
    setError("");
    try {
      const { error: joinError } = await client.rpc("platform_admin_join_group", { p_group_id: group.id });
      if (joinError) throw joinError;
      router.push(`/group/${encodeURIComponent(group.id)}`);
    } catch (failure) {
      setError(`Unable to manage group: ${failureMessage(failure)}`);
      setWorking("");
    }
  }

  if (!groups && !error) return null;
  return (
    <Card title="All groups (platform admin)">
      {error && <p role="alert">{error}</p>}
      {groups && (groups.length ? (
        <ul className="space-y-3">
          {groups.map((group) => (
            <li key={group.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
              <div className="min-w-0">
                <p className="break-words font-semibold text-slate-900">{group.name}</p>
                <p className="text-sm">{group.member_count} members · {group.admin_count} admins{group.my_role === "admin" ? " · You are an admin" : group.my_role ? " · You are a member" : ""}</p>
              </div>
              {group.my_role === "admin" ? (
                <ButtonLink href={`/group/${encodeURIComponent(group.id)}`} aria-label={`Open ${group.name}`}>Open</ButtonLink>
              ) : (
                <Button disabled={!!working} aria-label={`Manage ${group.name} as admin`} onClick={() => void manage(group)}>
                  {working === group.id ? "Joining…" : "Manage as admin"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : <p>No groups exist yet.</p>)}
    </Card>
  );
}

export type CompetitionRoleName = "participant" | "audience";

const roleCopy: Record<CompetitionRoleName, { join: string; summary: string }> = {
  participant: { join: "Join as participant", summary: "Submit your own entry. Participants do not vote." },
  audience: { join: "Join as audience", summary: "Vote on the entries. The audience does not submit entries." },
};

/** Lets a member choose, or change while allowed, how they take part. */
export function CompetitionRole({
  competitionId,
  status,
  role,
  hasEntry,
  onChanged,
}: {
  competitionId: string;
  status: string;
  role: CompetitionRoleName | null;
  hasEntry: boolean;
  onChanged: () => void;
}) {
  const { client } = useAuth();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const beforeVoting = status === "draft" || status === "submission";
  const available: CompetitionRoleName[] = role
    ? (beforeVoting && !(role === "participant" && hasEntry) ? [role === "participant" ? "audience" : "participant"] : [])
    : beforeVoting ? ["participant", "audience"] : status === "voting" ? ["audience"] : [];

  async function choose(next: CompetitionRoleName) {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const { error: joinError } = await client.rpc("join_competition", { p_competition_id: competitionId, p_role: next });
      if (joinError) throw joinError;
      onChanged();
    } catch (failure) {
      setError(`Unable to join: ${failureMessage(failure)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card title={role ? "How you take part" : "Take part"}>
      {role ? (
        <p>You are taking part as <strong>{role === "participant" ? "a participant" : "audience"}</strong>. {roleCopy[role].summary}</p>
      ) : available.length ? (
        <p>Choose how you take part. You can change your mind until voting starts.</p>
      ) : (
        <p>This competition is no longer open to new participants or audience.</p>
      )}
      {role && hasEntry && beforeVoting && <p className="text-sm">You have submitted an entry, so you stay a participant.</p>}
      {role && !beforeVoting && <p className="text-sm">Roles are fixed once voting starts.</p>}
      {available.map((next) => (
        <div key={next} className="space-y-2">
          {!role && <p className="text-sm">{roleCopy[next].summary}</p>}
          <Button disabled={working} onClick={() => void choose(next)}>
            {role ? `Switch to ${next === "participant" ? "participant" : "audience"}` : roleCopy[next].join}
          </Button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
