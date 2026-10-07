"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { failureMessage } from "@/lib/errors";
import { useLocale } from "@/lib/i18n";
import Button, { ButtonLink } from "@/components/Button";
import Card from "@/components/Card";
import IconButton, { Icon } from "@/components/IconButton";

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
  const { t } = useLocale();
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
        if (inviteError) setError(t("Unable to open this invite: {error}", { error: t(inviteError.message) }));
        else setInvite(((data || []) as InviteDetails[])[0] || null);
      } catch {
        if (active) setError(t("Unable to open this invite. Please try again."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, token, t]);

  async function join() {
    if (joining) return;
    setJoining(true);
    setError("");
    try {
      const { data, error: joinError } = await client.rpc("accept_group_invite", { p_token: token });
      if (joinError) throw joinError;
      router.push(`/group/${encodeURIComponent(String(data))}`);
    } catch (failure) {
      setError(t("Unable to join the group: {error}", { error: t(failureMessage(failure)) }));
      setJoining(false);
    }
  }

  if (loading) return <p role="status">{t("Opening invite…")}</p>;
  if (!invite) {
    return (
      <Card title={t("Invite unavailable")}>
        {error ? <p role="alert">{error}</p> : <p>{t("This invite link is invalid or has been revoked. Ask a group admin for a new one.")}</p>}
        <ButtonLink href="/dashboard">{t("Go to your groups")}</ButtonLink>
      </Card>
    );
  }
  if (invite.is_member) {
    return (
      <Card title={invite.group_name}>
        <p>{t("You are already a member of this group.")}</p>
        <ButtonLink href={`/group/${encodeURIComponent(invite.group_id)}`}>{t("Open group")}</ButtonLink>
      </Card>
    );
  }
  return (
    <Card title={t("Join {group}", { group: invite.group_name })}>
      <p>{t("You have been invited to this group. After joining, you can take part in its competitions as a participant or as audience.")}</p>
      {error && <p role="alert">{error}</p>}
      <Button disabled={joining} onClick={() => void join()}>{t(joining ? "Joining…" : "Join group")}</Button>
    </Card>
  );
}

type Member = { user_id: string; email: string; display_name?: string; role: "admin" | "member" };
type EmailInvite = { email: string; created_at: string };
type InviteLink = { id: string; token: string; created_at: string };

export function GroupMembers({ groupId }: { groupId: string }) {
  const { t } = useLocale();
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
          setError(t("Unable to load members: {error}", { error: t(failure.message) }));
          return;
        }
        setError("");
        setMembers((memberResult.data || []) as Member[]);
        setEmailInvites((emailResult.data || []) as EmailInvite[]);
        setLinks((linkResult.data || []) as InviteLink[]);
      } catch {
        if (active) setError(t("Unable to load members. Please try again."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, groupId, attempt, t, session.user.user_metadata.display_name]);

  async function act(key: string, label: string, run: () => PromiseLike<{ error: unknown }>) {
    if (working) return;
    setWorking(key);
    setActionError("");
    try {
      const { error: rpcError } = await run();
      if (rpcError) throw rpcError;
      refresh();
    } catch (failure) {
      setActionError(t("Unable to {action}: {error}", { action: t(label), error: t(failureMessage(failure)) }));
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
      setActionError(t("Unable to copy automatically. Select the link and copy it instead."));
    }
  }

  const adminCount = members.filter((member) => member.role === "admin").length;
  const inviteUrl = (token: string) => `${window.location.origin}/invite/${token}`;

  if (loading) return <p role="status">{t("Loading members…")}</p>;
  if (error) return <Card title={t("Members")}><p role="alert">{error}</p><Button onClick={refresh}>{t("Retry members")}</Button></Card>;

  return (
    <Card title={t("Members")}>
      <table className="w-full table-fixed text-left">
        <thead className="text-sm text-slate-500">
          <tr className="border-b border-slate-200">
            <th scope="col" className="w-12 pb-2 font-medium"><span className="sr-only">{t("Role")}</span></th>
            <th scope="col" className="pb-2 font-medium">{t("Name / email")}</th>
            <th scope="col" className="w-24 pb-2 text-right font-medium"><span className="sr-only">{t("Actions")}</span></th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const self = member.user_id === session.user.id;
            const lastAdmin = member.role === "admin" && adminCount === 1;
            const roleLabel = t(member.role === "admin" ? "Group admin" : "Member");
            return (
              <tr key={member.user_id} className="border-b border-slate-100 last:border-0">
                <td className="py-1">
                  <span role="img" aria-label={roleLabel} title={roleLabel} className={`inline-flex size-9 items-center justify-center rounded-full ${member.role === "admin" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>
                    <Icon name={member.role} />
                  </span>
                </td>
                <td className="break-words py-1 pr-2 text-slate-900">
                  {member.display_name?.trim() || member.email}{self && ` (${t("you")})`}
                  {member.display_name?.trim() && <span className="block text-sm break-all text-slate-500">{member.email}</span>}
                </td>
                <td className="py-1">
                  <div className="flex justify-end">
                    {member.role === "member" ? (
                      <IconButton icon="promote" disabled={!!working} aria-label={t("Make {email} a group admin", { email: member.email })} onClick={() => void act(member.user_id, "change role", () =>
                        client.rpc("set_group_member_role", { p_group_id: groupId, p_user_id: member.user_id, p_role: "admin" }))} />
                    ) : (
                      <IconButton icon="demote" disabled={!!working || lastAdmin} aria-label={t("Remove group admin role from {email}", { email: member.email })} title={lastAdmin ? t("A group needs at least one admin. Make someone else an admin first.") : undefined} onClick={() => {
                        if (self && !window.confirm(t("Stop being a group admin? You will lose access to group management."))) return;
                        void act(member.user_id, "change role", () =>
                          client.rpc("set_group_member_role", { p_group_id: groupId, p_user_id: member.user_id, p_role: "member" }));
                      }} />
                    )}
                    {self ? <span className="size-12 shrink-0" /> : (
                      <IconButton icon="removeMember" tone="danger" disabled={!!working || lastAdmin} aria-label={t("Remove {email} from the group", { email: member.email })} onClick={() => {
                        if (!window.confirm(t("Remove {email} from this group?", { email: member.email }))) return;
                        void act(member.user_id, "remove member", () =>
                          client.rpc("remove_group_member", { p_group_id: groupId, p_user_id: member.user_id }));
                      }} />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          {emailInvites.map((pending) => (
            <tr key={pending.email} className="border-b border-slate-100 last:border-0">
              <td className="py-1">
                <span role="img" aria-label={t("Invited")} title={t("Invited")} className="inline-flex size-9 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                  <Icon name="pending" />
                </span>
              </td>
              <td className="break-all py-1 pr-2 text-slate-500">{pending.email} · {t("waiting to sign in")}</td>
              <td className="py-1">
                <div className="flex justify-end">
                  <IconButton icon="cancel" tone="danger" disabled={!!working} aria-label={t("Cancel invite for {email}", { email: pending.email })} onClick={() => void act(pending.email, "cancel invite", () =>
                    client.rpc("revoke_group_email_invite", { p_group_id: groupId, p_email: pending.email }))} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="group border-t border-slate-200 pt-2">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
          {t("Invite people")}
          <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5 text-slate-500 transition-transform group-open:rotate-180">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </summary>
        <div className="space-y-4 pt-2">
          <form onSubmit={invite} aria-busy={working === "invite"}>
            <div className="flex items-center gap-1">
              <input type="email" required maxLength={320} aria-label={t("Email address")} aria-describedby="invite-email-hint" placeholder={t("Invite by email")} value={email} onChange={(event) => setEmail(event.target.value)} className="block min-h-12 min-w-0 flex-1 rounded border border-slate-300 p-2" />
              <IconButton type="submit" icon="invite" tone="primary" disabled={!!working || !email.trim()} aria-label={t(working === "invite" ? "Inviting…" : "Invite")} />
            </div>
            <p id="invite-email-hint" className="mt-1 text-xs text-slate-500">{t("No email is sent. They join when they next sign in with this address.")}</p>
          </form>

          <div className="space-y-2 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">{t("Invite links")}</h3>
              <IconButton icon="addLink" disabled={!!working} aria-label={t(working === "link" ? "Creating…" : "Create invite link")} onClick={() => void act("link", "create invite link", () =>
                client.rpc("create_group_invite", { p_group_id: groupId }))} />
            </div>
            {links.map((link) => (
              <div key={link.id} className="space-y-2">
                <div className="flex items-center gap-1">
                  <input readOnly aria-label={t("Invite link")} value={inviteUrl(link.token)} onFocus={(event) => event.target.select()} className="block min-h-12 min-w-0 flex-1 rounded border border-slate-300 p-2 font-mono" />
                  <IconButton icon={copied === link.id ? "save" : "copy"} aria-label={t(copied === link.id ? "Copied" : "Copy link")} onClick={() => void copy(link)} />
                  <IconButton icon="remove" tone="danger" disabled={!!working} aria-label={t("Revoke link")} onClick={() => {
                    if (!window.confirm(t("Revoke this invite link? People who have not joined yet can no longer use it."))) return;
                    void act(link.id, "revoke link", () => client.rpc("revoke_group_invite", { p_invite_id: link.id }));
                  }} />
                </div>
                <details>
                  <summary className="min-h-12 cursor-pointer py-3 font-medium text-indigo-700">{t("Show QR code")}</summary>
                  <div className="space-y-2">
                    <QRCodeSVG value={inviteUrl(link.token)} size={256} level="M" marginSize={4} role="img" aria-label={t("QR code for invite link")} className="h-auto max-w-full" />
                    <p className="text-sm text-slate-600">{t("Scan this QR code with your phone to open the invite link. Sign in to join the group.")}</p>
                  </div>
                </details>
              </div>
            ))}
            <p className="text-xs text-slate-500">{t("Anyone signed in who opens a link joins as a member.")}</p>
          </div>
        </div>
      </details>
      {actionError && <p role="alert">{actionError}</p>}
    </Card>
  );
}

type PlatformGroup = { id: string; name: string; member_count: number; admin_count: number; my_role: string | null };

/** Every group, for platform admins configured by the deployment. */
export function PlatformGroups() {
  const { t } = useLocale();
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
        if (listError) setError(t("Unable to load all groups: {error}", { error: t(listError.message) }));
        else setGroups((data || []) as PlatformGroup[]);
      } catch {
        // Not a platform admin, or the check is unavailable: show nothing.
      }
    })();
    return () => { active = false; };
  }, [client, t]);

  async function manage(group: PlatformGroup) {
    if (working || !window.confirm(t("Become a group admin of “{group}”? Its members will see you in the member list.", { group: group.name }))) return;
    setWorking(group.id);
    setError("");
    try {
      const { error: joinError } = await client.rpc("platform_admin_join_group", { p_group_id: group.id });
      if (joinError) throw joinError;
      router.push(`/group/${encodeURIComponent(group.id)}`);
    } catch (failure) {
      setError(t("Unable to manage group: {error}", { error: t(failureMessage(failure)) }));
      setWorking("");
    }
  }

  if (!groups && !error) return null;
  return (
    <Card title={t("All groups (platform admin)")}>
      {error && <p role="alert">{error}</p>}
      {groups && (groups.length ? (
        <table aria-label={t("All groups (platform admin)")} className="w-full table-fixed text-left">
          <thead className="text-sm text-slate-500">
            <tr className="border-b border-slate-200">
              <th scope="col" className="pb-2 font-medium">{t("Group name")}</th>
              <th scope="col" className="w-36 pb-2 text-right font-medium"><span className="sr-only">{t("Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id} className="border-b border-slate-100 last:border-0">
                <td className="break-words py-1 pr-2">
                  <p className="font-semibold text-slate-900">{group.name}</p>
                  <p className="text-sm">{t("{count} members", { count: group.member_count })} · {t("{count} admins", { count: group.admin_count })}{group.my_role === "admin" ? ` · ${t("You are an admin")}` : group.my_role ? ` · ${t("You are a member")}` : ""}</p>
                </td>
                <td className="py-1 text-right">
                  {group.my_role === "admin" ? (
                    <ButtonLink href={`/group/${encodeURIComponent(group.id)}`} aria-label={t("Open {group}", { group: group.name })}>{t("Open")}</ButtonLink>
                  ) : (
                    <Button disabled={!!working} aria-label={t("Manage {group} as admin", { group: group.name })} onClick={() => void manage(group)}>
                      {t(working === group.id ? "Joining…" : "Manage as admin")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>{t("No groups exist yet.")}</p>)}
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
  allowParticipantVoting = false,
  onChanged,
}: {
  competitionId: string;
  status: string;
  role: CompetitionRoleName | null;
  hasEntry: boolean;
  allowParticipantVoting?: boolean;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const { client } = useAuth();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const beforeVoting = status === "draft" || status === "submission";
  const summary = (next: CompetitionRoleName) => next === "participant" && allowParticipantVoting
    ? "Submit your own entry and vote on other entries. You cannot vote on your own entry."
    : roleCopy[next].summary;
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
      setError(t("Unable to join: {error}", { error: t(failureMessage(failure)) }));
    } finally {
      setWorking(false);
    }
  }

  const fixedReason = role && !available.length
    ? (!beforeVoting ? "Roles are fixed once voting starts." : hasEntry ? "You have submitted an entry, so you stay a participant." : null)
    : null;
  const roleStyle = (name: CompetitionRoleName) => name === "participant" ? "bg-violet-50 text-violet-700" : "bg-amber-50 text-amber-700";

  return (
    <Card title={t(role ? "How you take part" : "Take part")}>
      {role ? (
        <div className="flex items-center gap-3">
          <span aria-hidden className={`flex size-10 shrink-0 items-center justify-center rounded-full ${roleStyle(role)}`}><Icon name={role} /></span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-slate-900">{t(role === "participant" ? "You are taking part as a participant." : "You are taking part as audience.")}</p>
            <p className="text-sm">{t(summary(role))}</p>
          </div>
          {available.map((next) => (
            <IconButton key={next} icon="swap" disabled={working} aria-label={t(next === "participant" ? "Switch to participant" : "Switch to audience")} onClick={() => void choose(next)} />
          ))}
          {fixedReason && <IconButton icon="swap" disabled aria-label={t("Switch role")} title={t(fixedReason)} />}
        </div>
      ) : available.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((next) => (
            <button
              key={next}
              type="button"
              disabled={working}
              onClick={() => void choose(next)}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-indigo-400 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden className={`flex size-10 shrink-0 items-center justify-center rounded-full ${roleStyle(next)}`}><Icon name={next} /></span>
              <span className="min-w-0">
                <span className="block font-semibold text-slate-900">{t(roleCopy[next].join)}</span>
                <span className="block text-sm">{t(summary(next))}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p>{t("This competition is no longer open to new participants or audience.")}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
