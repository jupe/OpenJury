"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { failureMessage } from "@/lib/errors";
import Breadcrumbs, { type Crumb } from "@/components/Breadcrumbs";
import Button, { ButtonLink } from "@/components/Button";
import Card from "@/components/Card";
import ImageLightbox from "@/components/ImageLightbox";
import Toast, { type ToastMessage } from "@/components/Toast";
import { StatusBadge, nextTransition } from "@/components/CompetitionStatus";
import { CompetitionRole, type CompetitionRoleName } from "@/components/Membership";
import { useLocale } from "@/lib/i18n";

type LocalizedError = { message: string; error?: string };

function localizedFailure(message: string, failure: unknown): LocalizedError {
  return {
    message,
    error: failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string"
      ? failure.message : undefined,
  };
}

function ErrorText({ error }: { error: string | LocalizedError }) {
  const { t } = useLocale();
  return <>{typeof error === "string" ? t(error) : t(error.message, { error: t(error.error ?? "Please try again.") })}</>;
}

/** Scores are percentages of the maximum; whole numbers read better than the stored precision. */
const formatPercent = (score: number) => `${Math.round(score)}%`;

const MAX_MEDIA_FILES = 5;
const MAX_MEDIA_SIZE = 10 * 1024 * 1024;
const MEDIA_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

type Competition = {
  id: string;
  name: string;
  description: string | null;
  rules: string | null;
  status: string;
  submission_deadline: string | null;
  voting_deadline: string | null;
  results_publish_at: string | null;
  // A many-to-one embed is one object; untyped clients infer an array.
  groups?: { name: string } | { name: string }[] | null;
  // Row-level security returns only the signed-in member's own role.
  competition_participants?: { role: CompetitionRoleName }[] | null;
};

function competitionCrumbs(competitionId: string, competition: Competition, groupId: string | null, t: ReturnType<typeof useLocale>["t"]): Crumb[] {
  return [
    { label: t("Dashboard"), href: "/dashboard" },
    ...(groupId ? [{ label: [competition.groups].flat()[0]?.name || t("Group"), href: `/group/${encodeURIComponent(groupId)}` }] : []),
    { label: competition.name, href: `/competition/${encodeURIComponent(competitionId)}` },
  ];
}

function Deadlines({ competition }: { competition: Competition }) {
  const { t, formatDateTime } = useLocale();
  return (
    <>
      {competition.submission_deadline && (
        <p>{t("Submissions close {date}", { date: formatDateTime(competition.submission_deadline) })}</p>
      )}
      {competition.voting_deadline && (
        <p>{t("Voting closes {date}", { date: formatDateTime(competition.voting_deadline) })}</p>
      )}
    </>
  );
}

function CompetitionDetails({ competition }: { competition: Competition }) {
  const { t } = useLocale();
  return (
    <>
      {competition.description && (
        <section className="mt-4">
          <h3 className="font-semibold">{t("Description")}</h3>
          <p className="whitespace-pre-wrap break-words">{competition.description}</p>
        </section>
      )}
      {competition.rules && (
        <section className="mt-4">
          <h3 className="font-semibold">{t("Rules")}</h3>
          <p className="whitespace-pre-wrap break-words">{competition.rules}</p>
        </section>
      )}
    </>
  );
}

type Submission = { id: string; title: string; media_keys: string[] };
type BlindEntry = { entry_number: number; media_keys: string[] };
type AdminEntry = { id: string; creator_id: string; title: string; media_keys: string[] };
type CompetitionAttendee = {
  user_id: string;
  display_name: string;
  role: string;
  has_submission: boolean;
  has_voted: boolean;
};
type Category = { id: string; name: string; max_score: number };
type SavedScore = { entry_number: number; category_id: string; score: number };
type PublishedResult = {
  rank: number;
  score: number | null;
  vote_count: number;
  title: string;
  creator_id: string;
  creator_name: string;
  is_disqualified: boolean;
  media_keys?: string[] | null;
};
type PublishedCategoryResult = {
  category_id: string;
  category_name: string;
  rank: number;
  score: number;
  title: string;
  creator_name: string;
};
type AdminReviewResult = {
  entry_id: string;
  creator_id: string;
  title: string;
  is_disqualified: boolean;
  rank: number | null;
  score: number | null;
  vote_count: number;
  disqualification_reason: string | null;
  disqualified_by: string | null;
  disqualified_at: string | null;
  disqualification_display: "exclude" | "bottom" | "remove_content";
  content_removed: boolean;
};
type AdminCategoryResult = {
  category_id: string;
  category_name: string;
  entry_id: string;
  title: string;
  creator_id: string;
  rank: number;
  score: number;
};

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function MediaGallery({
  client,
  mediaKeys,
  label,
}: {
  client: ReturnType<typeof useAuth>["client"];
  mediaKeys: string[];
  label: string;
}) {
  const { t } = useLocale();
  const [images, setImages] = useState<Array<{ key: string; url: string }>>([]);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const gallery = useRef<HTMLDivElement>(null);
  const keyList = mediaKeys.join("\n");

  useEffect(() => {
    const element = gallery.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      void Promise.resolve().then(() => setVisible(true));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const urls: string[] = [];
    void (async () => {
      try {
        await Promise.resolve();
        if (!active) return;
        setError("");
        setImages([]);
        for (const key of keyList ? keyList.split("\n") : []) {
          const { data, error: downloadError } = await client.storage
            .from("competition-submissions")
            .download(key);
          if (!active) return;
          if (downloadError) throw downloadError;
          const url = URL.createObjectURL(data);
          urls.push(url);
          setImages((current) => [...current, { key, url }]);
        }
      } catch {
        if (active) setError("Some private media could not be loaded.");
      }
    })();
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [client, keyList, visible]);

  const shown = images.filter(({ key }) => mediaKeys.includes(key));
  return (
    <div ref={gallery} className={mediaKeys.length ? "min-h-24 sm:min-h-28" : ""}>
      {error && mediaKeys.length > 0 && <p role="alert">{t(error)}</p>}
      {shown.length > 0 && (
        <ul className="flex snap-x gap-2 overflow-x-auto pb-1">
          {shown.map(({ key, url }, index) => (
            <li key={key} className="shrink-0 snap-start">
              <button
                type="button"
                title={t("Open gallery")}
                onClick={() => setOpenAt(index)}
                className="block cursor-zoom-in overflow-hidden rounded-lg border border-slate-200 hover:border-indigo-400"
              >
                <Image
                  src={url}
                  alt={`${label} ${index + 1}`}
                  width={224}
                  height={224}
                  unoptimized
                  className="h-24 w-24 object-cover sm:h-28 sm:w-28"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {openAt !== null && shown.length > 0 && (
        <ImageLightbox images={shown} label={label} start={Math.min(openAt, shown.length - 1)} onClose={() => setOpenAt(null)} />
      )}
    </div>
  );
}

export function EntryWorkspace({ competitionId }: { competitionId: string }) {
  const { t, formatDateTime } = useLocale();
  const { client, session } = useAuth();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState<CompetitionRoleName | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [blindEntries, setBlindEntries] = useState<BlindEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ballotScores, setBallotScores] = useState<Record<number, Record<string, string>>>({});
  // Scores as last saved on the server; an entry listed here has been voted on.
  const [savedBallots, setSavedBallots] = useState<Record<number, Record<string, string>>>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  // Slider moves are saved after a short pause; saves for one entry run in order.
  const pendingBallots = useRef(new Map<number, { timer: number; save: () => void }>());
  const ballotQueue = useRef(new Map<number, Promise<void>>());
  const [publishedResults, setPublishedResults] = useState<PublishedResult[]>([]);
  const [publishedCategoryResults, setPublishedCategoryResults] = useState<PublishedCategoryResult[]>([]);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [votingOpen, setVotingOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [cleanupKeys, setCleanupKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | LocalizedError>("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setCompetition(null);
    setIsAdmin(false);
    setSubmission(null);
    setBlindEntries([]);
    setCategories([]);
    setBallotScores({});
    setSavedBallots({});
    setPublishedResults([]);
    setPublishedCategoryResults([]);
    try {
      const result = await client.from("competitions")
        .select("id,group_id,name,description,rules,status,submission_deadline,voting_deadline,results_publish_at,groups(name),competition_participants(role)")
        .eq("id", competitionId)
        .maybeSingle();
      if (result.error || !result.data) {
        setGroupId(null);
        setError(result.error
          ? localizedFailure("Unable to load competition: {error}", result.error)
          : { message: "Competition not found or access denied." });
        return;
      }
      setGroupId(result.data.group_id);
      setCompetition(result.data);
      setSubmissionOpen(result.data.status === "submission"
        && (!result.data.submission_deadline
          || Date.parse(result.data.submission_deadline) > Date.now()));
      const isVotingOpen = result.data.status === "voting"
        && (!result.data.voting_deadline
          || Date.parse(result.data.voting_deadline) > Date.now());
      setVotingOpen(isVotingOpen);
      const myRole = result.data.competition_participants?.[0]?.role ?? null;
      setRole(myRole);
      // Only the audience votes, and only it may load the anonymous ballot.
      const isBallotOpen = isVotingOpen && myRole === "audience";
      const [membership, mine, blind, categoryResult, savedBallot, finalResults, finalCategories] = await Promise.all([
        client.from("group_members").select("role")
          .eq("group_id", result.data.group_id).eq("user_id", session.user.id).maybeSingle(),
        client.rpc("get_my_submission", { p_competition_id: competitionId }),
        isBallotOpen
          ? client.rpc("get_blind_voting_entries", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
        isBallotOpen
          ? client.from("categories").select("id,name,max_score")
            .eq("competition_id", competitionId).order("name")
          : Promise.resolve({ data: [], error: null }),
        isBallotOpen
          ? client.rpc("get_my_ballot", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
        result.data.status === "results_published"
          ? client.rpc("get_published_competition_results", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
        result.data.status === "results_published"
          ? client.rpc("get_published_competition_category_results", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
      ]);
      // Only decides whether to offer the admin page; the server enforces access.
      setIsAdmin(membership.data?.role === "admin");
      if (mine.error) {
        setError(localizedFailure("Unable to load your submission: {error}", mine.error));
        return;
      }
      const own = (mine.data || [])[0] as Submission | undefined;
      setSubmission(own || null);
      setTitle(own?.title || "");
      if (blind.error) {
        setError(localizedFailure("Unable to load anonymous entries: {error}", blind.error));
        return;
      }
      if (categoryResult.error) {
        setError(localizedFailure("Unable to load scoring categories: {error}", categoryResult.error));
        return;
      }
      if (savedBallot.error) {
        setError(localizedFailure("Unable to load your ballot: {error}", savedBallot.error));
        return;
      }
      if (finalResults.error) {
        setError(localizedFailure("Unable to load published results: {error}", finalResults.error));
        return;
      }
      if (finalCategories.error) {
        setError(localizedFailure("Unable to load published category winners: {error}", finalCategories.error));
        return;
      }
      setBlindEntries((blind.data || []) as BlindEntry[]);
      setCategories((categoryResult.data || []) as Category[]);
      setPublishedResults((finalResults.data || []) as PublishedResult[]);
      setPublishedCategoryResults((finalCategories.data || []) as PublishedCategoryResult[]);
      const saved = (savedBallot.data || []).reduce(
        (scores: Record<number, Record<string, string>>, score: SavedScore) => ({
          ...scores,
          [score.entry_number]: {
            ...scores[score.entry_number],
            [score.category_id]: String(score.score),
          },
        }),
        {},
      );
      setBallotScores(saved);
      setSavedBallots(saved);
    } catch {
      setError({ message: "Unable to load competition submissions. Please try again." });
    } finally {
      setLoading(false);
    }
  }, [client, competitionId, session.user.id]);

  useRealtimeUpdates(client, session.user.id, groupId, load);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, session.user.id]);

  useEffect(() => {
    const deadline = competition?.status === "submission"
      ? competition.submission_deadline
      : competition?.status === "voting" ? competition.voting_deadline : null;
    if (!deadline) return;
    const delay = Date.parse(deadline) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => void load(), delay + 1);
    return () => window.clearTimeout(timer);
  }, [competition, load]);

  const editable = competition?.status === "submission" && submissionOpen && role === "participant";
  const activeMedia = (submission?.media_keys || []).filter((key) => !removedKeys.includes(key));

  function selectFiles(files: FileList | null) {
    const selected = Array.from(files || []);
    const available = MAX_MEDIA_FILES - activeMedia.length;
    if (selected.length > available) {
      setError(t("An entry may contain up to {count} images.", { count: MAX_MEDIA_FILES }));
      setNewFiles([]);
      return;
    }
    if (selected.some((file) => !MEDIA_TYPES.has(file.type) || file.size < 1 || file.size > MAX_MEDIA_SIZE)) {
      setError(t("Choose JPEG, PNG, or WebP images no larger than 10 MB each."));
      setNewFiles([]);
      return;
    }
    setError("");
    setNewFiles(selected);
  }

  async function cleanup(keys: string[]) {
    if (!keys.length) return [];
    const { error: cleanupError } = await client.storage
      .from("competition-submissions")
      .remove(keys);
    return cleanupError ? keys : [];
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !competition || !editable) return;
    setSaving(true);
    setError("");
    let entryId = submission?.id || null;
    const uploaded: string[] = [];
    try {
      const initialKeys = submission?.media_keys || [];
      const { data: initialId, error: initialError } = await client.rpc("save_submission", {
        p_competition_id: competitionId,
        p_entry_id: entryId,
        p_title: title.trim(),
        p_media_keys: initialKeys,
      });
      if (initialError || !initialId) throw initialError || new Error(t("Unable to save submission."));
      const savedEntryId = initialId;
      entryId = savedEntryId;

      for (const file of newFiles) {
        const extension = MEDIA_TYPES.get(file.type);
        if (!extension) throw new Error(t("Choose a supported image type."));
        const key = `${competitionId}/${savedEntryId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await client.storage
          .from("competition-submissions")
          .upload(key, file, {
            cacheControl: "0",
            contentType: file.type,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        uploaded.push(key);
      }

      const desiredKeys = [...activeMedia, ...uploaded];
      const { error: saveError } = await client.rpc("save_submission", {
        p_competition_id: competitionId,
        p_entry_id: savedEntryId,
        p_title: title.trim(),
        p_media_keys: desiredKeys,
      });
      if (saveError) throw saveError;

      setSubmission({ id: savedEntryId, title: title.trim(), media_keys: desiredKeys });
      setRemovedKeys([]);
      setNewFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      const pendingCleanup = await cleanup([
        ...initialKeys.filter((key) => !desiredKeys.includes(key)),
        ...cleanupKeys,
      ]);
      setCleanupKeys(pendingCleanup);
      setError(pendingCleanup.length ? t("Saved, but some removed media could not be cleaned up. Retry cleanup below.") : "");
    } catch (saveError) {
      const pendingCleanup = await cleanup(uploaded);
      setCleanupKeys(pendingCleanup);
      setError(localizedFailure("Unable to save submission: {error}", saveError instanceof Error ? saveError.message : t("Please try again.")));
      if (!submission && entryId) {
        const { data } = await client.rpc("get_my_submission", { p_competition_id: competitionId });
        const own = (data || [])[0] as Submission | undefined;
        if (own) setSubmission(own);
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryCleanup() {
    const pending = await cleanup(cleanupKeys);
    setCleanupKeys(pending);
    if (pending.length) setError(t("Some media could not be cleaned up. Please retry."));
    else setError("");
  }

  // Leaving the page saves any slider move still waiting for its pause.
  useEffect(() => {
    const pending = pendingBallots.current;
    return () => {
      for (const { timer, save } of [...pending.values()]) {
        window.clearTimeout(timer);
        save();
      }
    };
  }, []);

  /** The slider value for a category: the chosen score, or the middle of the scale before voting. */
  function ballotScore(entryNumber: number, category: Category) {
    return ballotScores[entryNumber]?.[category.id] || String(Math.ceil(category.max_score / 2));
  }

  function saveBallot(entryNumber: number, scores: Record<string, string>) {
    const previous = ballotQueue.current.get(entryNumber) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const { error: ballotError } = await client.rpc("save_ballot", {
          p_competition_id: competitionId,
          p_entry_number: entryNumber,
          p_scores: categories.map((category) => ({
            category_id: category.id,
            score: Number(scores[category.id]),
          })),
        });
        if (ballotError) throw ballotError;
        setSavedBallots((current) => ({ ...current, [entryNumber]: scores }));
        setToast({ id: Date.now(), text: t("Vote recorded · Entry {number}", { number: entryNumber }), tone: "success" });
      } catch {
        setToast({ id: Date.now(), text: t("Couldn't save your vote for Entry {number}. Move a slider to try again.", { number: entryNumber }), tone: "error" });
      }
    });
    ballotQueue.current.set(entryNumber, next);
  }

  function changeScore(entryNumber: number, categoryId: string, value: string) {
    if (!votingOpen) return;
    const scores = {
      ...Object.fromEntries(categories.map((category) => [category.id, ballotScore(entryNumber, category)])),
      [categoryId]: value,
    };
    setBallotScores((current) => ({ ...current, [entryNumber]: scores }));
    const pending = pendingBallots.current;
    window.clearTimeout(pending.get(entryNumber)?.timer);
    const save = () => {
      pending.delete(entryNumber);
      saveBallot(entryNumber, scores);
    };
    pending.set(entryNumber, { timer: window.setTimeout(save, 400), save });
  }

  if (loading) return <p role="status">{t("Loading competition…")}</p>;
  if (!competition) return <p role="alert"><ErrorText error={error || { message: "Competition is unavailable." }} /></p>;

  return (
    <div className="space-y-6">
      <Breadcrumbs items={competitionCrumbs(competitionId, competition, groupId, t).map((crumb, index, all) =>
        index === all.length - 1 ? { label: crumb.label } : crumb)} />
      <Card title={competition.name}>
        <p className="flex flex-wrap items-center gap-2">{t("Status:")} <StatusBadge status={competition.status} /></p>
        <Deadlines competition={competition} />
        <CompetitionDetails competition={competition} />
        {isAdmin && (
          <ButtonLink href={`/competition/${encodeURIComponent(competitionId)}/admin`}>
            {t("Manage competition")}
          </ButtonLink>
        )}
      </Card>

      {["draft", "submission", "voting"].includes(competition.status) && (
        <CompetitionRole
          competitionId={competitionId}
          status={competition.status}
          role={role}
          hasEntry={!!submission}
          onChanged={() => void load()}
        />
      )}

      {editable && (
        <Card title={t(submission ? "Edit your submission" : "Submit an entry")}>
          <form onSubmit={save} className="space-y-4" aria-busy={saving}>
            <label className="block">{t("Entry title")}
              <input
                required
                maxLength={100}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 p-2"
              />
            </label>
            <MediaGallery client={client} mediaKeys={activeMedia} label={t("Your submission image")} />
            {submission?.media_keys.map((key, index) => !removedKeys.includes(key) && (
              <Button
                key={key}
                type="button"
                onClick={() => setRemovedKeys((current) => [...current, key])}
              >
                {t("Remove image {number}", { number: index + 1 })}
              </Button>
            ))}
            <label className="block">{t("Images (JPEG, PNG, or WebP; up to 5 files, 10 MB each)")}
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => selectFiles(event.target.files)}
                className="mt-1 block w-full"
              />
            </label>
            {newFiles.length > 0 && <p>{t("{count} new image(s) selected.", { count: newFiles.length })}</p>}
            {error && <p role="alert"><ErrorText error={error} /></p>}
            <Button type="submit" disabled={saving}>{t(saving ? "Saving…" : "Save submission")}</Button>
          </form>
        </Card>
      )}

      {cleanupKeys.length > 0 && (
        <Button disabled={saving} onClick={() => void retryCleanup()}>{t("Retry media cleanup")}</Button>
      )}

      {competition.status === "voting" && votingOpen && role === "participant" && (
        <Card title={t("Voting in progress")}>
          <p>{t("The audience is voting on anonymous entries now. Participants do not vote.")}</p>
        </Card>
      )}
      {competition.status === "voting" && votingOpen && role === "audience" && (
        <Card title={t("Anonymous entries")}>
          {blindEntries.length ? (
            <ol className="space-y-6">
              {blindEntries.map((entry) => {
                return (
                  <li key={entry.entry_number} className="space-y-3">
                    <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                      {t("Entry {number}", { number: entry.entry_number })}
                      {savedBallots[entry.entry_number] && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">{t("Voted")}</span>
                      )}
                    </h2>
                    <MediaGallery
                      client={client}
                      mediaKeys={entry.media_keys}
                      label={t("Anonymous entry {number} image", { number: entry.entry_number })}
                    />
                    <div className="space-y-1">
                      {categories.map((category) => {
                        const id = `ballot-${entry.entry_number}-${category.id}`;
                        const score = ballotScore(entry.entry_number, category);
                        return (
                          <div key={category.id} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3">
                            <label htmlFor={id} className="truncate">{category.name}</label>
                            <input
                              id={id}
                              type="range"
                              min={1}
                              max={category.max_score}
                              step={1}
                              value={score}
                              onChange={(event) => changeScore(entry.entry_number, category.id, event.target.value)}
                              className="h-11 w-full cursor-pointer accent-indigo-600"
                            />
                            <span aria-hidden className="w-12 text-right font-semibold tabular-nums">{score}/{category.max_score}</span>
                          </div>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p>{t("No entries are available for blind voting.")}</p>}
          <Toast toast={toast} onDismiss={dismissToast} />
        </Card>
      )}
      {competition.status === "voting" && !votingOpen && (
        <Card title={t("Voting closed")}>
          <p>{t("The voting deadline has passed. Preliminary results are not available to members.")}</p>
        </Card>
      )}
      {competition.status === "review_pending" && (
        <Card title={t("Voting ended")}>
          <p>{t("Voting has ended! The administrator is reviewing the results. Please wait for the results to be published.")}</p>
          {competition.results_publish_at && (
            <p>{t("Results are scheduled to be published {date}.", { date: formatDateTime(competition.results_publish_at) })}</p>
          )}
        </Card>
      )}
      {competition.status === "results_published" && (
        <Card title={t("Published results")}>
          {publishedResults.length ? (
            <ol className="space-y-3">
              {publishedResults.map((result) => (
                <li key={`${result.rank}:${result.creator_id}`} className="space-y-2 rounded border border-slate-200 p-3">
                  <h2 className="font-semibold">{t("Rank {rank}: {title}", { rank: result.rank, title: result.title })}</h2>
                  <p>{t("Submitted by {name}", { name: result.creator_name || t("Participant") })}</p>
                  {result.media_keys && result.media_keys.length > 0 && (
                    <MediaGallery client={client} mediaKeys={result.media_keys} label={`${result.title} image`} />
                  )}
                  {result.is_disqualified
                    ? <p>{t("Disqualified")}</p>
                    : <p>{result.score === null ? "—" : formatPercent(result.score)} · {t("{count} complete ballots", { count: result.vote_count })}</p>}
                </li>
              ))}
            </ol>
          ) : <p>{t("No results were published.")}</p>}
          {publishedCategoryResults.length > 0 && (
            <section className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold">{t("Category winners")}</h2>
              {[...new Map(publishedCategoryResults.map((result) => [
                result.category_id,
                result.category_name,
              ])).entries()].map(([categoryId, categoryName]) => (
                <section key={categoryId}>
                  <h3 className="font-semibold">{categoryName}</h3>
                  <ol className="list-inside list-decimal">
                    {publishedCategoryResults.filter((result) => result.category_id === categoryId).map((result, index) => (
                      <li key={`${categoryId}:${index}`}>
                        {result.rank === 1 ? `${t("Winner:")} ` : ""}{result.title} ({result.creator_name})
                        {" — "}{formatPercent(result.score)}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </section>
          )}
        </Card>
      )}
      {error && !editable && <p role="alert"><ErrorText error={error} /></p>}
    </div>
  );
}

export function AdminSubmissions({ competitionId }: { competitionId: string }) {
  const { session } = useAuth();
  // Remount for each account so a switched user (e.g. a demo persona) never sees stale admin data.
  return <AdminSubmissionsView key={session.user.id} competitionId={competitionId} />;
}

function AdminSubmissionsView({ competitionId }: { competitionId: string }) {
  const { t, formatDateTime } = useLocale();
  const { client, session } = useAuth();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [entries, setEntries] = useState<AdminEntry[]>([]);
  const [attendees, setAttendees] = useState<CompetitionAttendee[]>([]);
  const [competitionRoles, setCompetitionRoles] = useState<Record<string, CompetitionRoleName>>({});
  const [reviewResults, setReviewResults] = useState<AdminReviewResult[] | null>(null);
  const [reviewCategories, setReviewCategories] = useState<AdminCategoryResult[]>([]);
  const [competitionStatus, setCompetitionStatus] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [dispositions, setDispositions] = useState<Record<string, "exclude" | "bottom" | "remove_content">>({});
  const [pendingMediaCleanup, setPendingMediaCleanup] = useState<Record<string, string[]>>({});
  const [workingEntry, setWorkingEntry] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | LocalizedError>("");
  const [forbidden, setForbidden] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<LocalizedError | null>(null);
  const [detailsDraft, setDetailsDraft] = useState<{ name: string; description: string; rules: string } | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<LocalizedError | null>(null);
  const [detailsMessage, setDetailsMessage] = useState("");
  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    setEntries([]);
    setAttendees([]);
    setReviewResults(null);
    setCompetitionStatus("");
    setCompetition(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [submissionResult, competitionResult, attendeeResult, roleResult] = await Promise.all([
          client.rpc("get_admin_submissions", { p_competition_id: competitionId }),
          client.from("competitions")
            .select("id,group_id,name,description,rules,status,submission_deadline,voting_deadline,results_publish_at,groups(name)")
            .eq("id", competitionId).maybeSingle(),
          client.rpc("get_admin_competition_attendees", { p_competition_id: competitionId }),
          client.rpc("get_competition_participants", { p_competition_id: competitionId }),
        ]);
        if (!active) return;
        if (submissionResult.error?.code === "42501") {
          setForbidden(true);
          return;
        }
        if (submissionResult.error) {
          setError(localizedFailure("Unable to load admin submissions: {error}", submissionResult.error));
          return;
        }
        if (competitionResult.error || !competitionResult.data) {
          setError(competitionResult.error
            ? localizedFailure("Unable to load competition status: {error}", competitionResult.error)
            : { message: "Unable to load competition status: Competition not found." });
          return;
        }
        if (attendeeResult.error) {
          setError(localizedFailure("Unable to load competition attendees: {error}", attendeeResult.error));
          return;
        }
        setGroupId(competitionResult.data.group_id);
        setAttendees((attendeeResult.data || []) as CompetitionAttendee[]);
        // Roles only annotate the attendee list, so a failure leaves them out.
        setCompetitionRoles(Object.fromEntries(((roleResult.data || []) as Array<{ user_id: string; role: CompetitionRoleName }>)
          .map((row) => [row.user_id, row.role])));
        setCompetition(competitionResult.data);
        setPublishAt(localDateTime(competitionResult.data.results_publish_at));
        setEntries((submissionResult.data || []) as AdminEntry[]);
        setCompetitionStatus(competitionResult.data.status);
        if (competitionResult.data.status === "review_pending") {
          const [review, categories] = await Promise.all([
            client.rpc("get_admin_review_results", { p_competition_id: competitionId }),
            client.rpc("get_admin_review_category_results", { p_competition_id: competitionId }),
          ]);
          if (!active) return;
          if (review.error) setError(localizedFailure("Unable to load preliminary results: {error}", review.error));
          else setReviewResults((review.data || []) as AdminReviewResult[]);
          if (categories.error) setError(localizedFailure("Unable to load category winners: {error}", categories.error));
          else setReviewCategories((categories.data || []) as AdminCategoryResult[]);
        }
      } catch {
        if (active) setError({ message: "Unable to load admin submissions. Please try again." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, competitionId, attempt]);

  useRealtimeUpdates(client, session.user.id, groupId, refresh);

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detailsDraft || savingDetails) return;
    setSavingDetails(true);
    setDetailsError(null);
    try {
      const { error: saveError } = await client.rpc("save_competition_details", {
        p_competition_id: competitionId,
        p_name: detailsDraft.name.trim(),
        p_description: detailsDraft.description.trim() || null,
        p_rules: detailsDraft.rules.trim() || null,
      });
      if (saveError) throw saveError;
      setDetailsDraft(null);
      setDetailsMessage("Competition details saved.");
      refresh();
    } catch (failure) {
      setDetailsError(localizedFailure("Unable to save competition details: {error}", failure));
    } finally {
      setSavingDetails(false);
    }
  }

  async function refreshReviewResults() {
    const [review, categories] = await Promise.all([
      client.rpc("get_admin_review_results", { p_competition_id: competitionId }),
      client.rpc("get_admin_review_category_results", { p_competition_id: competitionId }),
    ]);
    if (review.error) throw review.error;
    if (categories.error) throw categories.error;
    setReviewResults((review.data || []) as AdminReviewResult[]);
    setReviewCategories((categories.data || []) as AdminCategoryResult[]);
  }

  async function advance() {
    const step = nextTransition[competitionStatus];
    if (!step || transitioning || !window.confirm(t(step.confirm))) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const { error: transitionFailure } = await client.rpc("transition_competition", {
        p_competition_id: competitionId,
        p_target_status: step.target,
      });
      if (transitionFailure) throw transitionFailure;
      refresh();
    } catch (failure) {
      setTransitionError(localizedFailure(step.error, failure));
    } finally {
      setTransitioning(false);
    }
  }

  async function disqualify(entry: AdminReviewResult) {
    const reason = reasons[entry.entry_id]?.trim();
    if (!reason || workingEntry) return;
    const disposition = dispositions[entry.entry_id] || "exclude";
    if (disposition === "remove_content"
      && !window.confirm(t("Remove this entry's title and private images? The entry and moderation audit remain, but it cannot be reinstated."))) return;
    setWorkingEntry(entry.entry_id);
    setError("");
    setActionMessage("");
    try {
      const { error: disqualifyError } = await client.rpc("disqualify_competition_entry", {
        p_competition_id: competitionId,
        p_entry_id: entry.entry_id,
        p_reason: reason,
        p_disposition: disposition,
      });
      if (disqualifyError) throw disqualifyError;
      let cleanupFailure = "";
      if (disposition === "remove_content") {
        const submission = entries.find((item) => item.id === entry.entry_id);
        setEntries((current) => current.map((item) => item.id === entry.entry_id
          ? { ...item, title: t("Content removed"), media_keys: [] }
          : item));
        if (submission?.media_keys.length) {
          const { error: removeError } = await client.storage
            .from("competition-submissions")
            .remove(submission.media_keys);
          if (removeError) {
            setPendingMediaCleanup((current) => ({ ...current, [entry.entry_id]: submission.media_keys }));
            cleanupFailure = t("The entry was hidden, but private image cleanup failed. Retry cleanup below.");
          }
        }
      }
      await refreshReviewResults();
      setReasons((current) => ({ ...current, [entry.entry_id]: "" }));
      if (cleanupFailure) setError(cleanupFailure);
    } catch (reviewError) {
      setError(localizedFailure("Unable to disqualify entry: {error}", reviewError));
    } finally {
      setWorkingEntry("");
    }
  }

  async function retryMediaCleanup(entryId: string) {
    const keys = pendingMediaCleanup[entryId];
    if (!keys?.length) return;
    const { error: cleanupError } = await client.storage.from("competition-submissions").remove(keys);
    if (cleanupError) {
      setError(localizedFailure("Unable to remove private images: {error}", cleanupError));
      return;
    }
    setPendingMediaCleanup((current) => {
      const next = { ...current };
      delete next[entryId];
      return next;
    });
    setError("");
  }

  async function reinstate(entry: AdminReviewResult) {
    const reason = reasons[entry.entry_id]?.trim();
    if (!reason || workingEntry) return;
    setWorkingEntry(entry.entry_id);
    setError("");
    try {
      const { error: reinstateError } = await client.rpc("reinstate_competition_entry", {
        p_competition_id: competitionId,
        p_entry_id: entry.entry_id,
        p_reason: reason,
      });
      if (reinstateError) throw reinstateError;
      await refreshReviewResults();
      setReasons((current) => ({ ...current, [entry.entry_id]: "" }));
    } catch (reviewError) {
      setError(localizedFailure("Unable to reinstate entry: {error}", reviewError));
    } finally {
      setWorkingEntry("");
    }
  }

  async function saveSchedule() {
    try {
      const { error: scheduleError } = await client.rpc("set_competition_results_schedule", {
        p_competition_id: competitionId,
        p_publish_at: publishAt ? new Date(publishAt).toISOString() : null,
      });
      if (scheduleError) throw scheduleError;
      setActionMessage(publishAt ? "Publication schedule saved." : "Scheduled publication cancelled.");
      refresh();
    } catch (scheduleError) {
      setError(localizedFailure("Unable to save publication schedule: {error}", scheduleError));
    }
  }

  async function publishResults() {
    if (publishing) return;
    setPublishing(true);
    setError("");
    setActionMessage("");
    try {
      const { error: publishError } = await client.rpc("publish_competition_results", {
        p_competition_id: competitionId,
      });
      if (publishError) throw publishError;
      setCompetitionStatus("results_published");
      setReviewResults(null);
      setActionMessage("Results published. Group members can now view the final rankings and identities.");
    } catch (publishError) {
      setError(localizedFailure("Unable to publish results: {error}", publishError));
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return <p role="status">{t("Loading admin submissions…")}</p>;
  if (forbidden) {
    return (
      <Card title={t("Admin access required")}>
        <p>{t("Only group administrators can manage this competition.")}</p>
        <ButtonLink href={`/competition/${encodeURIComponent(competitionId)}`}>{t("View competition")}</ButtonLink>
      </Card>
    );
  }
  if (error && !competition) return <p role="alert"><ErrorText error={error} /></p>;
  const step = nextTransition[competitionStatus];

  const attendeeName = (userId: string) =>
    attendees.find((attendee) => attendee.user_id === userId)?.display_name || t("Participant");

  return (
    <div className="space-y-6">
      {competition && (
        <Breadcrumbs items={[...competitionCrumbs(competitionId, competition, groupId, t), { label: t("Manage") }]} />
      )}
      <Card title={competition?.name || t("Competition status")}>
        <p className="flex flex-wrap items-center gap-2">{t("Status:")} <StatusBadge status={competitionStatus} /></p>
        {competition && <Deadlines competition={competition} />}
        {competitionStatus === "draft" && (
          <p>{t("Edit scoring categories, event type, and deadlines from the group page before opening submissions. Competition details remain editable.")}</p>
        )}
        {competitionStatus === "review_pending" && (
          <>
            <p>{t("Review the preliminary rankings below, then publish the final results.")}</p>
            <label className="mt-3 block max-w-sm">{t("Schedule results publication")}
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(event) => setPublishAt(event.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 p-2"
              />
            </label>
            <p className="text-sm text-slate-600">{t("Change the time or leave it blank to cancel the schedule. You can update it any time before publication.")}</p>
            <Button onClick={() => void saveSchedule()}>{t("Save publication schedule")}</Button>
          </>
        )}
        {transitionError && <p role="alert"><ErrorText error={transitionError} /></p>}
        {step && (
          <Button disabled={transitioning} onClick={() => void advance()}>
            {t(transitioning ? "Updating…" : step.action)}
          </Button>
        )}
      </Card>
      {competition && (
        <Card title={t("Competition details")}>
          {detailsDraft ? (
            <form onSubmit={saveDetails} className="space-y-4" aria-busy={savingDetails}>
              <fieldset disabled={savingDetails} className="space-y-4">
                <label className="block">{t("Competition name")}
                  <input required maxLength={100} value={detailsDraft.name} onChange={(event) => setDetailsDraft({ ...detailsDraft, name: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                </label>
                <label className="block">{t("Description (optional)")}
                  <textarea maxLength={10000} rows={3} value={detailsDraft.description} onChange={(event) => setDetailsDraft({ ...detailsDraft, description: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                </label>
                <label className="block">{t("Rules (optional)")}
                  <textarea maxLength={10000} rows={4} value={detailsDraft.rules} onChange={(event) => setDetailsDraft({ ...detailsDraft, rules: event.target.value })} className="mt-1 block w-full rounded border border-slate-300 p-2" />
                </label>
                <div className="flex flex-wrap gap-3">
                  <Button type="submit">{t(savingDetails ? "Saving…" : "Save details")}</Button>
                  <Button type="button" variant="secondary" onClick={() => { setDetailsDraft(null); setDetailsError(null); }}>{t("Cancel edit")}</Button>
                </div>
              </fieldset>
              {detailsError && <p role="alert"><ErrorText error={detailsError} /></p>}
            </form>
          ) : (
            <>
              <CompetitionDetails competition={competition} />
              <Button onClick={() => {
                setDetailsDraft({ name: competition.name, description: competition.description ?? "", rules: competition.rules ?? "" });
                setDetailsError(null);
                setDetailsMessage("");
              }}>{t("Edit competition details")}</Button>
            </>
          )}
          {detailsMessage && <p role="status">{t(detailsMessage)}</p>}
        </Card>
      )}
      <Card title={t("Competition attendees")}>
      <p>{t("Group members and anyone who has submitted or voted, with how each takes part in this competition.")}</p>
        {attendees.length ? (
          <ul className="space-y-3">
            {attendees.map((attendee) => (
              <li key={attendee.user_id} className="rounded border border-slate-200 p-3">
                <p className="break-words font-semibold">{attendee.display_name || t("Participant")}</p>
                <p className="text-sm text-slate-600">
                  {t(attendee.role === "admin" ? "Admin" : attendee.role === "member" ? "Member" : "Former member")}
                  {" · "}{t(competitionRoles[attendee.user_id] === "participant" ? "Participant"
                    : competitionRoles[attendee.user_id] === "audience" ? "Audience" : "Not taking part")}
                  {" · "}{t(attendee.has_submission ? "Submitted" : "No submission")}
                  {" · "}{t(attendee.has_voted ? "Has voted" : "Has not voted")}
                </p>
              </li>
            ))}
          </ul>
        ) : <p>{t("No attendees are involved yet.")}</p>}
      </Card>
      <Card title={t("Private submission review")}>
        {entries.length ? (
          <ul className="space-y-6">
            {entries.map((entry) => (
              <li key={entry.id} className="space-y-2">
                <h2 className="font-semibold">{entry.title}</h2>
                <p className="break-words text-sm text-slate-600">{t("Submitted by {name}", { name: attendeeName(entry.creator_id) })}</p>
                <MediaGallery client={client} mediaKeys={entry.media_keys} label={t("Submission image")} />
              </li>
            ))}
          </ul>
        ) : <p>{t("No submissions have been received.")}</p>}
      </Card>
      {reviewResults && (
        <Card title={t("Preliminary rankings (admins only)")}>
          <p>{t("Scores are category-normalized averages. Ties share a rank; only complete ballots count.")}</p>
          <ul className="space-y-4">
            {reviewResults.map((entry) => (
              <li key={entry.entry_id} className="rounded border border-slate-200 p-4">
                <h2 className="font-semibold">
                  {entry.rank === null ? t("Not ranked") : t("Rank {rank}", { rank: entry.rank })}: {entry.title}
                </h2>
                <p className="break-words text-sm text-slate-600">{t("Submitted by {name}", { name: attendeeName(entry.creator_id) })}</p>
                {!entry.is_disqualified && (
                  <p>{entry.score === null ? t("No complete ballots") : formatPercent(entry.score)}
                    {" · "}{t("{count} complete ballots", { count: entry.vote_count })}</p>
                )}
                {entry.is_disqualified && (
                  <p>
                    {entry.content_removed ? t("Content removed") : `${t("Disqualified")} (${t(entry.disqualification_display === "exclude" ? "Exclude from results" : entry.disqualification_display === "bottom" ? "Show as disqualified at bottom" : "Remove inappropriate content")})`}: {entry.disqualification_reason}
                    {entry.disqualified_by && ` · ${t("Admin {name}", { name: attendeeName(entry.disqualified_by) })}`}
                    {entry.disqualified_at && ` · ${formatDateTime(entry.disqualified_at)}`}
                  </p>
                )}
                {entry.is_disqualified && !entry.content_removed && (
                  <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                    <label className="min-w-0">{t("Reason for reinstatement")}
                      <input
                        maxLength={488}
                        value={reasons[entry.entry_id] || ""}
                        onChange={(event) => setReasons((current) => ({
                          ...current, [entry.entry_id]: event.target.value,
                        }))}
                        className="mt-1 block w-full rounded border border-slate-300 p-2"
                      />
                    </label>
                    <Button
                      disabled={!reasons[entry.entry_id]?.trim() || workingEntry !== ""}
                      onClick={() => void reinstate(entry)}
                    >
                      {t("Reinstate entry")}
                    </Button>
                  </div>
                )}
                {pendingMediaCleanup[entry.entry_id]?.length > 0 && (
                  <Button onClick={() => void retryMediaCleanup(entry.entry_id)}>
                    {t("Retry private image cleanup")}
                  </Button>
                )}
                {!entry.is_disqualified && (
                  <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto]">
                    <label className="col-span-2 min-w-0 sm:col-span-1">{t("Disqualification reason")}
                      <input
                        maxLength={500}
                        value={reasons[entry.entry_id] || ""}
                        onChange={(event) => setReasons((current) => ({
                          ...current, [entry.entry_id]: event.target.value,
                        }))}
                        className="mt-1 block w-full rounded border border-slate-300 p-2"
                      />
                    </label>
                    <label className="min-w-0">{t("Result handling")}
                      <select
                        value={dispositions[entry.entry_id] || "exclude"}
                        onChange={(event) => setDispositions((current) => ({
                          ...current,
                          [entry.entry_id]: event.target.value as "exclude" | "bottom" | "remove_content",
                        }))}
                        className="mt-1 block min-h-11 w-full rounded border border-slate-300 p-2"
                      >
                        <option value="exclude">{t("Exclude from results")}</option>
                        <option value="bottom">{t("Show as disqualified at bottom")}</option>
                        <option value="remove_content">{t("Remove inappropriate content")}</option>
                      </select>
                    </label>
                    <Button
                      disabled={!reasons[entry.entry_id]?.trim() || workingEntry !== ""}
                      onClick={() => void disqualify(entry)}
                    >
                      {t(workingEntry === entry.entry_id ? "Disqualifying…" : "Disqualify")}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {reviewCategories.filter((category) => category.rank === 1).length > 0 && (
            <section className="mt-6 space-y-2">
              <h2 className="text-lg font-semibold">{t("Preliminary category winners")}</h2>
              {reviewCategories.filter((category) => category.rank === 1).map((winner) => (
                <p key={`${winner.category_id}:${winner.entry_id}`}>
                  {winner.category_name}: {winner.title} ({attendeeName(winner.creator_id)}) — {formatPercent(winner.score)}
                </p>
              ))}
            </section>
          )}
          {actionMessage && <p role="status">{t(actionMessage)}</p>}
          <Button disabled={publishing || workingEntry !== ""} onClick={() => void publishResults()}>
            {t(publishing ? "Publishing…" : "Publish final results")}
          </Button>
        </Card>
      )}
      {competitionStatus === "results_published" && actionMessage && <p role="status">{t(actionMessage)}</p>}
      {error && <p role="alert"><ErrorText error={error} /></p>}
    </div>
  );
}
