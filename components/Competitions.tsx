"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import AddButton from "@/components/AddButton";
import Button from "@/components/Button";
import { StatusBadge } from "@/components/CompetitionStatus";
import Card from "@/components/Card";
import IconButton, { IconLink } from "@/components/IconButton";
import type { CompetitionRoleName } from "@/components/Membership";
import { useLocale } from "@/lib/i18n";

type CompetitionError = { message: string; error?: string };

type Competition = {
  id: string;
  name: string;
  description: string | null;
  rules: string | null;
  max_submission_images?: number;
  submission_type?: "photo" | "text";
  allow_participant_voting: boolean;
  event_type: "live" | "remote";
  status: string;
  submission_deadline: string | null;
  voting_deadline: string | null;
  results_publish_at: string | null;
  // Row-level security returns only the signed-in user's own role row.
  competition_participants?: { role: CompetitionRoleName }[] | null;
};

const roleBadges: Record<CompetitionRoleName, { tip: string; className: string; icon: string }> = {
  participant: {
    tip: "You are a participant: you submit an entry",
    className: "border-indigo-200 bg-indigo-50 text-indigo-700",
    icon: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4",
  },
  audience: {
    tip: "You are in the audience: you score the entries",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    icon: "m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8L12 3Z",
  },
};

/** The signed-in user's own role in a competition, as an icon with a tooltip shown on hover, tap or focus. */
function RoleBadge({ role }: { role: CompetitionRoleName }) {
  const { t } = useLocale();
  const badge = roleBadges[role];
  return (
    // The tooltip positions against the surrounding badge row, so it stays inside the card.
    <span className="group inline-flex">
      <span
        role="img"
        tabIndex={0}
        aria-label={t(badge.tip)}
        className={`flex h-7 w-7 cursor-help items-center justify-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${badge.className}`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d={badge.icon} />
        </svg>
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute top-full right-0 z-20 mt-1.5 w-max max-w-56 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {t(badge.tip)}
      </span>
    </span>
  );
}

/** The competition's latest scheduled date; undated competitions sort last. */
function latestDate(competition: Competition) {
  const date = competition.voting_deadline ?? competition.submission_deadline ?? competition.results_publish_at;
  return date ? Date.parse(date) : Number.MIN_SAFE_INTEGER;
}

type CategoryDraft = { name: string; max_score: number };
type CompetitionDraft = {
  id: string | null;
  name: string;
  description: string;
  rules: string;
  allowParticipantVoting: boolean;
  eventType: "live" | "remote";
  submissionDeadline: string;
  votingDeadline: string;
  maxSubmissionImages: number;
  submissionType: "photo" | "text";
  categories: CategoryDraft[];
};

function emptyDraft(): CompetitionDraft {
  return {
    id: null,
    name: "",
    description: "",
    rules: "",
    allowParticipantVoting: false,
    eventType: "remote",
    submissionDeadline: "",
    votingDeadline: "",
    maxSubmissionImages: 5,
    submissionType: "photo",
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

function SetupLabel({ label, htmlFor, help, children, action }: {
  label: string;
  htmlFor?: string;
  help: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useLocale();
  const helpId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="flex items-center gap-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="flex min-w-0 items-center gap-3">{children}{t(label)}</label>
        ) : <span className="font-semibold">{t(label)}</span>}
        <button
          type="button"
          aria-label={t("Help: {field}", { field: t(label) })}
          aria-expanded={expanded}
          aria-controls={helpId}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-xs font-semibold">?</span>
        </button>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <p id={helpId} hidden={!expanded} className="mb-2 rounded-xl bg-slate-100 p-3 text-sm text-slate-600">{t(help)}</p>
    </>
  );
}

export function CompetitionManager({ groupId }: { groupId: string }) {
  const { t, formatDateTime } = useLocale();
  const { client, session } = useAuth();
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CompetitionError | null>(null);
  const [saveError, setSaveError] = useState<CompetitionError | null>(null);
  const [deleteError, setDeleteError] = useState<CompetitionError | null>(null);
  const [competitionToRemove, setCompetitionToRemove] = useState<Competition | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editError, setEditError] = useState<CompetitionError | null>(null);
  const [draft, setDraft] = useState<CompetitionDraft>(emptyDraft);
  const [attempt, setAttempt] = useState(0);
  const formDialog = useRef<HTMLDialogElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
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
            .select("id,name,description,rules,max_submission_images,submission_type,allow_participant_voting,event_type,status,submission_deadline,voting_deadline,results_publish_at,competition_participants(role)")
            .eq("group_id", groupId)
            .order("name")
            .abortSignal(controller.signal),
        ]);
        if (!active) return;
        if (membership.error) setError({ message: "Unable to check group access: {error}", error: membership.error.message });
        else if (result.error) setError({ message: "Unable to load competitions: {error}", error: result.error.message });
        else {
          setIsAdmin(membership.data?.role === "admin");
          setCompetitions([...(result.data || [])].sort((a, b) => latestDate(b) - latestDate(a)));
        }
      } catch {
        if (active) setError({ message: "Unable to load competitions. Please try again." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, groupId, session.user.id, attempt]);

  // Links such as the mobile Competitions tab land on this list once it has loaded.
  useEffect(() => {
    if (!loading && window.location.hash === "#competitions") {
      document.getElementById("competitions")?.scrollIntoView({ block: "start" });
    }
  }, [loading]);

  function newCompetition() {
    setEditError(null);
    setDraft(emptyDraft());
    setEditing(false);
    setSaveError(null);
    formDialog.current?.showModal();
  }

  // Closing by Cancel, Escape, or a successful save discards the unsaved form.
  function resetForm() {
    setDraft(emptyDraft());
    setEditing(false);
    setSaveError(null);
  }

  async function editCompetition(competition: Competition) {
    setLoadingEdit(true);
    setEditError(null);
    setSaveError(null);
    try {
      const { data, error: queryError } = await client.from("categories")
        .select("name,max_score")
        .eq("competition_id", competition.id)
        .order("name");
      if (queryError) {
        setEditError({ message: "Unable to load scoring categories: {error}", error: queryError.message });
        return;
      }
      setDraft({
        id: competition.id,
        name: competition.name,
        description: competition.description ?? "",
        rules: competition.rules ?? "",
        allowParticipantVoting: competition.allow_participant_voting ?? false,
        eventType: competition.event_type,
        submissionDeadline: toLocalInput(competition.submission_deadline),
        votingDeadline: toLocalInput(competition.voting_deadline),
        maxSubmissionImages: competition.max_submission_images ?? 5,
        submissionType: competition.submission_type ?? "photo",
        categories: (data || []).map((category) => ({
          name: category.name,
          max_score: category.max_score,
        })),
      });
      setEditing(true);
      formDialog.current?.showModal();
    } catch {
      setEditError({ message: "Unable to load scoring categories. Please try again." });
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
      setSaveError({ message: "Voting deadline must be after the submission deadline." });
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const { error: rpcError } = await client.rpc("save_draft_competition", {
        p_competition_id: draft.id,
        p_group_id: groupId,
        p_name: draft.name.trim(),
        p_description: draft.description.trim() || null,
        p_rules: draft.rules.trim() || null,
        p_allow_participant_voting: draft.allowParticipantVoting,
        p_event_type: draft.eventType,
        p_submission_deadline: toTimestamp(draft.submissionDeadline),
        p_voting_deadline: toTimestamp(draft.votingDeadline),
        p_max_submission_images: draft.maxSubmissionImages,
        p_submission_type: draft.submissionType,
        p_categories: draft.categories.map((category) => ({
          name: category.name.trim(),
          max_score: category.max_score,
        })),
      });
      if (rpcError) {
        setSaveError({ message: "Unable to save competition: {error}", error: rpcError.message });
        return;
      }
      formDialog.current?.close();
      setLoading(true);
      setAttempt((value) => value + 1);
    } catch {
      setSaveError({ message: "Unable to save competition. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  function openRemoveDialog(competition: Competition) {
    setDeleteError(null);
    setCompetitionToRemove(competition);
    removeDialog.current?.showModal();
  }

  async function deleteCompetition() {
    if (deletingId || !competitionToRemove || !isAdmin) return;
    const competition = competitionToRemove;
    setDeletingId(competition.id);
    setDeleteError(null);
    try {
      const { error: rpcError } = await client.rpc("delete_competition", {
        p_competition_id: competition.id,
      });
      if (rpcError) {
        setDeleteError({ message: "Unable to remove competition: {error}", error: rpcError.message });
        return;
      }
      if (draft.id === competition.id) {
        setDraft(emptyDraft());
        setEditing(false);
      }
      removeDialog.current?.close();
      setLoading(true);
      setCompetitions([]);
      setAttempt((value) => value + 1);
    } catch {
      setDeleteError({ message: "Unable to remove competition. Please try again." });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <Card id="competitions" title={t("Competitions")} action={isAdmin && <AddButton aria-label={t("New competition")} onClick={newCompetition} />}>
        {loading ? <p role="status">{t("Loading competitions…")}</p> : error ? (
          <>
            <p role="alert">{t(error.message, { error: t(error.error ?? "") })}</p>
            <Button onClick={() => { setLoading(true); setError(null); setAttempt((value) => value + 1); }}>{t("Retry competitions")}</Button>
          </>
        ) : competitions.length ? (
          <ul className="space-y-4">
            {competitions.map((competition) => (
              <li key={competition.id} className="space-y-1 rounded border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-3">
                  <Link className="inline-flex min-h-11 min-w-0 flex-[1_1_10rem] items-center font-semibold break-words underline" href={`/competition/${encodeURIComponent(competition.id)}`}>
                    {competition.name}
                  </Link>
                  <p className="relative ml-auto flex min-h-11 shrink-0 items-center gap-2 text-sm text-slate-600">
                    {competition.competition_participants?.[0] && <RoleBadge role={competition.competition_participants[0].role} />}
                    <StatusBadge status={competition.status} />
                    {t(competition.event_type === "live" ? "Live" : "Remote")}
                    {t(competition.submission_type === "text" ? "Text submissions" : "Photo submissions")}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-sm text-slate-600">
                    {competition.submission_deadline && t("Submissions close {date}", { date: formatDateTime(competition.submission_deadline) })}
                    {competition.submission_deadline && competition.voting_deadline && " · "}
                    {competition.voting_deadline && t("Voting closes {date}", { date: formatDateTime(competition.voting_deadline) })}
                  </p>
                  {isAdmin && (
                    <div className="flex shrink-0">
                      {competition.status === "draft" && (
                        <IconButton icon="edit" disabled={loadingEdit} aria-label={t(loadingEdit ? "Loading…" : "Edit draft")} onClick={() => void editCompetition(competition)} />
                      )}
                      <IconLink
                        icon="manage"
                        href={`/competition/${encodeURIComponent(competition.id)}/admin`}
                        aria-label={t("Manage {name}", { name: competition.name })}
                      />
                      <IconButton
                        icon="remove"
                        tone="danger"
                        disabled={deletingId !== null || saving || loadingEdit}
                        aria-label={t(deletingId === competition.id ? "Working…" : "Remove {name}", { name: competition.name })}
                        onClick={() => openRemoveDialog(competition)}
                      />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p>{t("No competitions have been created for this group yet.")}</p>}
        {editError && <p role="alert">{t(editError.message, { error: t(editError.error ?? "") })}</p>}
      </Card>

      {isAdmin && (
        <dialog
          ref={removeDialog}
          aria-labelledby="remove-competition-title"
          aria-describedby="remove-competition-warning"
          onCancel={(event) => { if (deletingId) event.preventDefault(); }}
          onClose={() => { setCompetitionToRemove(null); setDeleteError(null); }}
          className="app-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-5 shadow-xl"
        >
          <div className="space-y-4" aria-busy={deletingId !== null}>
            <h2 id="remove-competition-title" className="text-lg font-semibold break-words">
              {t("Remove competition “{name}”?", { name: competitionToRemove?.name ?? "" })}
            </h2>
            <p id="remove-competition-warning" className="text-slate-600 break-words">
              {t("Remove “{name}” and permanently delete its competition data? This cannot be undone.", { name: competitionToRemove?.name ?? "" })}
            </p>
            {deleteError && <p role="alert">{t(deleteError.message, { error: t(deleteError.error ?? "") })}</p>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" autoFocus disabled={deletingId !== null} onClick={() => removeDialog.current?.close()} className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">{t("Cancel")}</button>
              <Button className="bg-red-700 hover:bg-red-800 active:bg-red-900" disabled={deletingId !== null} onClick={() => void deleteCompetition()}>
                {t(deletingId ? "Working…" : "Remove competition")}
              </Button>
            </div>
          </div>
        </dialog>
      )}

      {isAdmin && (
        <dialog ref={formDialog} aria-labelledby="competition-form-title" onClose={resetForm} className="app-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-5 shadow-xl">
          <form onSubmit={saveCompetition} className="space-y-4" aria-busy={saving}>
            <div className="flex items-center justify-between gap-3">
              <h2 id="competition-form-title" className="text-lg font-semibold">{t(editing ? "Edit draft competition" : "Create a draft competition")}</h2>
              <IconButton icon="cancel" aria-label={t("Close")} disabled={saving} onClick={() => formDialog.current?.close()} />
            </div>
            <label className="block">{t("Competition name")}
              <input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <div>
              <SetupLabel label="Description (optional)" htmlFor="competition-description" help="Tell members what the competition is about, such as the theme, location, or what to submit. You can update the description and rules later." />
              <textarea id="competition-description" maxLength={10000} rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </div>
            <div>
              <SetupLabel label="Rules (optional)" htmlFor="competition-rules" help="Explain who can enter, what is allowed, and how entries will be judged. Ask members to avoid names or identifying marks so voting stays blind." />
              <textarea id="competition-rules" maxLength={10000} rows={4} value={draft.rules} onChange={(event) => setDraft({ ...draft, rules: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </div>
            <label className="block">{t("Submission format")}
              <select value={draft.submissionType} onChange={(event) => setDraft({ ...draft, submissionType: event.target.value as "photo" | "text" })} className="mt-1 block w-full rounded border border-slate-300 p-2">
                <option value="photo">{t("Photos")}</option>
                <option value="text">{t("Text")}</option>
              </select>
            </label>
            <p className="text-sm text-slate-600">{t("Submission format is fixed once submissions open.")}</p>
            {draft.submissionType === "photo" && (
              <div>
                <SetupLabel label="Maximum photos per entry" htmlFor="competition-photos" help="Choose 1–20 photos per entry. Each photo can be up to 10 MB. This limit is fixed once submissions open." />
                <input id="competition-photos" type="number" inputMode="numeric" required min={1} max={20} value={draft.maxSubmissionImages} onChange={(event) => setDraft({ ...draft, maxSubmissionImages: Number(event.target.value) })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </div>
            )}
            <div>
              <SetupLabel label="Allow participants to vote" htmlFor="competition-participant-voting" help="Participants can score other entries, never their own. This setting is fixed once submissions open.">
                <input id="competition-participant-voting" type="checkbox" checked={draft.allowParticipantVoting} onChange={(event) => setDraft({ ...draft, allowParticipantVoting: event.target.checked })} className="h-5 w-5" />
              </SetupLabel>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-[minmax(8rem,10rem)_minmax(0,1fr)_minmax(0,1fr)]">
              <div className="sm:col-span-2 md:col-span-1">
                <SetupLabel label="Event type" htmlFor="competition-event-type" help="Remote competitions can advance automatically at their deadlines when scheduled processing is configured. Live competitions are advanced by an admin. Both use blind voting." />
                <select id="competition-event-type" value={draft.eventType} onChange={(event) => setDraft({ ...draft, eventType: event.target.value as "live" | "remote" })} className="mt-1 block w-full rounded border border-slate-300 p-2">
                  <option value="remote">{t("Remote")}</option>
                  <option value="live">{t("Live")}</option>
                </select>
              </div>
              <div>
                <SetupLabel label="Submission deadline" htmlFor="competition-submission-deadline" help="Optional. Set the last time members can submit or edit an entry, in your local time zone. Leave blank to close submissions manually." />
                <input id="competition-submission-deadline" type="datetime-local" value={draft.submissionDeadline} onChange={(event) => setDraft({ ...draft, submissionDeadline: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </div>
              <div>
                <SetupLabel label="Voting deadline" htmlFor="competition-voting-deadline" help="Optional. Set the last time voters can save or revise scores, in your local time zone. It must be after the submission deadline if both are set. Results are reviewed before publication." />
                <input id="competition-voting-deadline" type="datetime-local" value={draft.votingDeadline} onChange={(event) => setDraft({ ...draft, votingDeadline: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </div>
            </div>
            <fieldset className="space-y-3">
              <legend className="sr-only">{t("Scoring categories")}</legend>
              <SetupLabel label="Scoring categories" help="Add at least one category, such as Taste, Creativity, or Presentation. Give each a unique name and a maximum score from 1 to 5. Overall scores average each category's points equally, so a higher maximum allows a category to contribute more points. Scoring settings are fixed once submissions open." action={
                <AddButton aria-label={t("Add category")} onClick={() => setDraft({
                  ...draft,
                  categories: [...draft.categories, { name: "", max_score: 5 }],
                })} />
              } />
              {draft.categories.map((category, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:grid-cols-[1fr_8rem_auto]">
                  <label className="col-span-2 block sm:col-span-1">{t("Category name")}
                    <input required maxLength={100} value={category.name} onChange={(event) => setDraft({
                      ...draft,
                      categories: draft.categories.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item),
                    })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                  </label>
                  <label className="block">{t("Maximum score")}
                    <input type="number" inputMode="numeric" required min={1} max={5} value={category.max_score} onChange={(event) => setDraft({
                      ...draft,
                      categories: draft.categories.map((item, itemIndex) => itemIndex === index ? { ...item, max_score: Number(event.target.value) } : item),
                    })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                  </label>
                  <IconButton icon="remove" tone="danger" aria-label={t("Remove category")} disabled={draft.categories.length === 1} onClick={() => setDraft({
                    ...draft,
                    categories: draft.categories.filter((_, itemIndex) => itemIndex !== index),
                  })} />
                </div>
              ))}
            </fieldset>
            {saveError && <p role="alert">{t(saveError.message, { error: t(saveError.error ?? "") })}</p>}
            <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" disabled={saving} onClick={() => formDialog.current?.close()}>{t("Cancel")}</Button>
              <Button type="submit" disabled={saving} className="sm:min-w-56 sm:text-base">{t(saving ? "Saving…" : editing ? "Save draft" : "Create competition")}</Button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
