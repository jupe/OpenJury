"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import Button, { ButtonLink } from "@/components/Button";
import { StatusBadge } from "@/components/CompetitionStatus";
import Card from "@/components/Card";

type Competition = {
  id: string;
  name: string;
  event_type: "live" | "remote";
  status: string;
  submission_deadline: string | null;
  voting_deadline: string | null;
};

type CategoryDraft = { name: string; max_score: number };
type CompetitionDraft = {
  id: string | null;
  name: string;
  eventType: "live" | "remote";
  submissionDeadline: string;
  votingDeadline: string;
  categories: CategoryDraft[];
};

function emptyDraft(): CompetitionDraft {
  return {
    id: null,
    name: "",
    eventType: "remote",
    submissionDeadline: "",
    votingDeadline: "",
    categories: [{ name: "", max_score: 5 }],
  };
}

function toLocalInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function toTimestamp(value: string) {
  return value ? new Date(value).toISOString() : null;
}

export function CompetitionManager({ groupId }: { groupId: string }) {
  const { client, session } = useAuth();
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [draft, setDraft] = useState<CompetitionDraft>(emptyDraft);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    setCompetitions([]);
    setIsAdmin(false);
    setAttempt((value) => value + 1);
  }, []);

  useRealtimeUpdates(client, session.user.id, groupId, refresh);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const [membership, result] = await Promise.all([
          client.from("group_members")
            .select("role")
            .eq("group_id", groupId)
            .eq("user_id", session.user.id)
            .abortSignal(controller.signal)
            .maybeSingle(),
          client.from("competitions")
            .select("id,name,event_type,status,submission_deadline,voting_deadline")
            .eq("group_id", groupId)
            .order("name")
            .abortSignal(controller.signal),
        ]);
        if (!active) return;
        if (membership.error) setError(`Unable to check group access: ${membership.error.message}`);
        else if (result.error) setError(`Unable to load competitions: ${result.error.message}`);
        else {
          setIsAdmin(membership.data?.role === "admin");
          setCompetitions(result.data || []);
        }
      } catch {
        if (active) setError("Unable to load competitions. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, groupId, session.user.id, attempt]);

  async function editCompetition(competition: Competition) {
    setLoadingEdit(true);
    setSaveError("");
    try {
      const { data, error: queryError } = await client.from("categories")
        .select("name,max_score")
        .eq("competition_id", competition.id)
        .order("name");
      if (queryError) {
        setSaveError(`Unable to load scoring categories: ${queryError.message}`);
        return;
      }
      setDraft({
        id: competition.id,
        name: competition.name,
        eventType: competition.event_type,
        submissionDeadline: toLocalInput(competition.submission_deadline),
        votingDeadline: toLocalInput(competition.voting_deadline),
        categories: (data || []).map((category) => ({
          name: category.name,
          max_score: category.max_score,
        })),
      });
      setEditing(true);
    } catch {
      setSaveError("Unable to load scoring categories. Please try again.");
    } finally {
      setLoadingEdit(false);
    }
  }

  async function saveCompetition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (
      draft.submissionDeadline
      && draft.votingDeadline
      && new Date(draft.votingDeadline) <= new Date(draft.submissionDeadline)
    ) {
      setSaveError("Voting deadline must be after the submission deadline.");
      return;
    }

    setSaving(true);
    setSaveError("");
    try {
      const { error: rpcError } = await client.rpc("save_draft_competition", {
        p_competition_id: draft.id,
        p_group_id: groupId,
        p_name: draft.name.trim(),
        p_event_type: draft.eventType,
        p_submission_deadline: toTimestamp(draft.submissionDeadline),
        p_voting_deadline: toTimestamp(draft.votingDeadline),
        p_categories: draft.categories.map((category) => ({
          name: category.name.trim(),
          max_score: category.max_score,
        })),
      });
      if (rpcError) {
        setSaveError(`Unable to save competition: ${rpcError.message}`);
        return;
      }
      setDraft(emptyDraft());
      setEditing(false);
      setLoading(true);
      setAttempt((value) => value + 1);
    } catch {
      setSaveError("Unable to save competition. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card title="Competitions">
        {loading ? <p role="status">Loading competitions…</p> : error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>Retry competitions</Button>
          </>
        ) : competitions.length ? (
          <ul className="space-y-4">
            {competitions.map((competition) => (
              <li key={competition.id} className="rounded border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <Link className="inline-flex min-h-11 items-center font-semibold underline" href={`/competition/${encodeURIComponent(competition.id)}`}>
                      {competition.name}
                    </Link>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                      <StatusBadge status={competition.status} />
                      {competition.event_type === "live" ? "Live" : "Remote"}
                    </p>
                  </div>
                  {isAdmin && (
                    <div className="flex flex-wrap gap-3">
                      {competition.status === "draft" && (
                        <Button disabled={loadingEdit} onClick={() => void editCompetition(competition)}>
                          {loadingEdit ? "Loading…" : "Edit draft"}
                        </Button>
                      )}
                      <ButtonLink
                        href={`/competition/${encodeURIComponent(competition.id)}/admin`}
                        aria-label={`Manage ${competition.name}`}
                      >
                        Manage
                      </ButtonLink>
                    </div>
                  )}
                </div>
                {(competition.submission_deadline || competition.voting_deadline) && (
                  <p className="mt-2 text-sm text-slate-600">
                    {competition.submission_deadline && `Submissions close ${new Date(competition.submission_deadline).toLocaleString()}`}
                    {competition.submission_deadline && competition.voting_deadline && " · "}
                    {competition.voting_deadline && `Voting closes ${new Date(competition.voting_deadline).toLocaleString()}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : <p>No competitions have been created for this group yet.</p>}
      </Card>

      {isAdmin && (
        <Card title={editing ? "Edit draft competition" : "Create a draft competition"}>
          <form onSubmit={saveCompetition} className="space-y-4" aria-busy={saving}>
            <label className="block">Competition name
              <input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <label className="block">Event type
              <select value={draft.eventType} onChange={(event) => setDraft({ ...draft, eventType: event.target.value as "live" | "remote" })} className="mt-1 block w-full rounded border border-slate-300 p-2">
                <option value="remote">Remote</option>
                <option value="live">Live</option>
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">Submission deadline
                <input type="datetime-local" value={draft.submissionDeadline} onChange={(event) => setDraft({ ...draft, submissionDeadline: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </label>
              <label className="block">Voting deadline
                <input type="datetime-local" value={draft.votingDeadline} onChange={(event) => setDraft({ ...draft, votingDeadline: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </label>
            </div>
            <fieldset className="space-y-3">
              <legend className="font-semibold">Scoring categories (maximum score 1–5)</legend>
              {draft.categories.map((category, index) => (
                <div key={index} className="grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
                  <label className="block">Category name
                    <input required maxLength={100} value={category.name} onChange={(event) => setDraft({
                      ...draft,
                      categories: draft.categories.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item),
                    })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                  </label>
                  <label className="block">Maximum score
                    <input type="number" inputMode="numeric" required min={1} max={5} value={category.max_score} onChange={(event) => setDraft({
                      ...draft,
                      categories: draft.categories.map((item, itemIndex) => itemIndex === index ? { ...item, max_score: Number(event.target.value) } : item),
                    })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                  </label>
                  <Button type="button" disabled={draft.categories.length === 1} onClick={() => setDraft({
                    ...draft,
                    categories: draft.categories.filter((_, itemIndex) => itemIndex !== index),
                  })}>Remove</Button>
                </div>
              ))}
              <Button type="button" onClick={() => setDraft({
                ...draft,
                categories: [...draft.categories, { name: "", max_score: 5 }],
              })}>Add category</Button>
            </fieldset>
            {saveError && <p role="alert">{saveError}</p>}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save draft" : "Create competition"}</Button>
              {editing && <Button type="button" disabled={saving} onClick={() => { setEditing(false); setDraft(emptyDraft()); setSaveError(""); }}>Cancel edit</Button>}
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
