"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { failureMessage } from "@/lib/errors";
import Breadcrumbs, { type Crumb } from "@/components/Breadcrumbs";
import Button, { ButtonLink } from "@/components/Button";
import Card from "@/components/Card";
import { StatusBadge, nextTransition } from "@/components/CompetitionStatus";
import { CompetitionRole, type CompetitionRoleName } from "@/components/Membership";

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
  status: string;
  submission_deadline: string | null;
  voting_deadline: string | null;
  results_publish_at: string | null;
  // A many-to-one embed is one object; untyped clients infer an array.
  groups?: { name: string } | { name: string }[] | null;
  // Row-level security returns only the signed-in member's own role.
  competition_participants?: { role: CompetitionRoleName }[] | null;
};

function competitionCrumbs(competitionId: string, competition: Competition, groupId: string | null): Crumb[] {
  return [
    { label: "Dashboard", href: "/dashboard" },
    ...(groupId ? [{ label: [competition.groups].flat()[0]?.name || "Group", href: `/group/${encodeURIComponent(groupId)}` }] : []),
    { label: competition.name, href: `/competition/${encodeURIComponent(competitionId)}` },
  ];
}

function Deadlines({ competition }: { competition: Competition }) {
  return (
    <>
      {competition.submission_deadline && (
        <p>Submissions close {new Date(competition.submission_deadline).toLocaleString()}</p>
      )}
      {competition.voting_deadline && (
        <p>Voting closes {new Date(competition.voting_deadline).toLocaleString()}</p>
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
  const [images, setImages] = useState<Array<{ key: string; url: string }>>([]);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
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

  return (
    <div ref={gallery} className={mediaKeys.length ? "min-h-32" : ""}>
      {error && mediaKeys.length > 0 && <p role="alert">{error}</p>}
      {images.some(({ key }) => mediaKeys.includes(key)) && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.filter(({ key }) => mediaKeys.includes(key)).map(({ key, url }, index) => (
            <details key={key} className="min-w-0 rounded-xl border border-slate-200 p-2 open:col-span-full">
              <summary className="cursor-pointer text-sm font-medium text-indigo-700">
                View image {index + 1}
                <Image
                  src={url}
                  alt={`${label} ${index + 1}`}
                  width={128}
                  height={128}
                  unoptimized
                  className="mt-2 aspect-square w-full rounded-lg object-cover"
                />
              </summary>
              <Image
                src={url}
                alt={`${label} ${index + 1}, full view`}
                width={1024}
                height={1024}
                unoptimized
                className="mt-3 h-auto max-h-[70dvh] w-full rounded-lg object-contain"
              />
              <p className="mt-2 text-sm">Tap “View image {index + 1}” again to close.</p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export function EntryWorkspace({ competitionId }: { competitionId: string }) {
  const { client, session } = useAuth();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState<CompetitionRoleName | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [blindEntries, setBlindEntries] = useState<BlindEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ballotScores, setBallotScores] = useState<Record<number, Record<string, string>>>({});
  const [ballotFeedback, setBallotFeedback] = useState<Record<number, string>>({});
  const [savingBallot, setSavingBallot] = useState<number | null>(null);
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
  const [error, setError] = useState("");
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
    setPublishedResults([]);
    setPublishedCategoryResults([]);
    try {
      const result = await client.from("competitions")
        .select("id,group_id,name,status,submission_deadline,voting_deadline,results_publish_at,groups(name),competition_participants(role)")
        .eq("id", competitionId)
        .maybeSingle();
      if (result.error || !result.data) {
        setGroupId(null);
        setError(result.error?.message || "Competition not found or access denied.");
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
        setError(`Unable to load your submission: ${mine.error.message}`);
        return;
      }
      const own = (mine.data || [])[0] as Submission | undefined;
      setSubmission(own || null);
      setTitle(own?.title || "");
      if (blind.error) {
        setError(`Unable to load anonymous entries: ${blind.error.message}`);
        return;
      }
      if (categoryResult.error) {
        setError(`Unable to load scoring categories: ${categoryResult.error.message}`);
        return;
      }
      if (savedBallot.error) {
        setError(`Unable to load your ballot: ${savedBallot.error.message}`);
        return;
      }
      if (finalResults.error) {
        setError(`Unable to load published results: ${finalResults.error.message}`);
        return;
      }
      if (finalCategories.error) {
        setError(`Unable to load published category winners: ${finalCategories.error.message}`);
        return;
      }
      setBlindEntries((blind.data || []) as BlindEntry[]);
      setCategories((categoryResult.data || []) as Category[]);
      setPublishedResults((finalResults.data || []) as PublishedResult[]);
      setPublishedCategoryResults((finalCategories.data || []) as PublishedCategoryResult[]);
      setBallotScores((savedBallot.data || []).reduce(
        (scores: Record<number, Record<string, string>>, score: SavedScore) => ({
          ...scores,
          [score.entry_number]: {
            ...scores[score.entry_number],
            [score.category_id]: String(score.score),
          },
        }),
        {},
      ));
    } catch {
      setError("Unable to load competition submissions. Please try again.");
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
      setError(`An entry may contain up to ${MAX_MEDIA_FILES} images.`);
      setNewFiles([]);
      return;
    }
    if (selected.some((file) => !MEDIA_TYPES.has(file.type) || file.size < 1 || file.size > MAX_MEDIA_SIZE)) {
      setError("Choose JPEG, PNG, or WebP images no larger than 10 MB each.");
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
      if (initialError || !initialId) throw initialError || new Error("Unable to save submission.");
      const savedEntryId = initialId;
      entryId = savedEntryId;

      for (const file of newFiles) {
        const extension = MEDIA_TYPES.get(file.type);
        if (!extension) throw new Error("Choose a supported image type.");
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
      setError(pendingCleanup.length ? "Saved, but some removed media could not be cleaned up. Retry cleanup below." : "");
    } catch (saveError) {
      const pendingCleanup = await cleanup(uploaded);
      setCleanupKeys(pendingCleanup);
      setError(`Unable to save submission: ${saveError instanceof Error ? saveError.message : "Please try again."}`);
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
    if (pending.length) setError("Some media could not be cleaned up. Please retry.");
    else setError("");
  }

  async function saveBallot(event: FormEvent<HTMLFormElement>, entry: BlindEntry) {
    event.preventDefault();
    if (savingBallot !== null || !votingOpen || categories.length === 0) return;
    const scores = ballotScores[entry.entry_number] || {};
    if (categories.some((category) => !scores[category.id])) {
      setBallotFeedback((current) => ({
        ...current,
        [entry.entry_number]: "Choose a score for every category.",
      }));
      return;
    }

    setSavingBallot(entry.entry_number);
    setBallotFeedback((current) => ({ ...current, [entry.entry_number]: "" }));
    try {
      const { error: ballotError } = await client.rpc("save_ballot", {
        p_competition_id: competitionId,
        p_entry_number: entry.entry_number,
        p_scores: categories.map((category) => ({
          category_id: category.id,
          score: Number(scores[category.id]),
        })),
      });
      if (ballotError) throw ballotError;
      setBallotFeedback((current) => ({
        ...current,
        [entry.entry_number]: "Ballot saved. You can revise it until voting closes.",
      }));
    } catch {
      setBallotFeedback((current) => ({
        ...current,
        [entry.entry_number]: "Unable to save this ballot. Please try again.",
      }));
    } finally {
      setSavingBallot(null);
    }
  }

  if (loading) return <p role="status">Loading competition…</p>;
  if (!competition) return <p role="alert">{error || "Competition is unavailable."}</p>;

  return (
    <div className="space-y-6">
      <Breadcrumbs items={competitionCrumbs(competitionId, competition, groupId).map((crumb, index, all) =>
        index === all.length - 1 ? { label: crumb.label } : crumb)} />
      <Card title={competition.name}>
        <p className="flex flex-wrap items-center gap-2">Status: <StatusBadge status={competition.status} /></p>
        <Deadlines competition={competition} />
        {isAdmin && (
          <ButtonLink href={`/competition/${encodeURIComponent(competitionId)}/admin`}>
            Manage competition
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
        <Card title={submission ? "Edit your submission" : "Submit an entry"}>
          <form onSubmit={save} className="space-y-4" aria-busy={saving}>
            <label className="block">Entry title
              <input
                required
                maxLength={100}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 p-2"
              />
            </label>
            <MediaGallery client={client} mediaKeys={activeMedia} label="Your submission image" />
            {submission?.media_keys.map((key, index) => !removedKeys.includes(key) && (
              <Button
                key={key}
                type="button"
                onClick={() => setRemovedKeys((current) => [...current, key])}
              >
                Remove image {index + 1}
              </Button>
            ))}
            <label className="block">Images (JPEG, PNG, or WebP; up to 5 files, 10 MB each)
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => selectFiles(event.target.files)}
                className="mt-1 block w-full"
              />
            </label>
            {newFiles.length > 0 && <p>{newFiles.length} new image(s) selected.</p>}
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save submission"}</Button>
          </form>
        </Card>
      )}

      {cleanupKeys.length > 0 && (
        <Button disabled={saving} onClick={() => void retryCleanup()}>Retry media cleanup</Button>
      )}

      {competition.status === "voting" && votingOpen && role === "participant" && (
        <Card title="Voting in progress">
          <p>The audience is voting on anonymous entries now. Participants do not vote.</p>
        </Card>
      )}
      {competition.status === "voting" && votingOpen && role === "audience" && (
        <Card title="Anonymous entries">
          {blindEntries.length ? (
            <ol className="space-y-6">
              {blindEntries.map((entry) => (
                <li key={entry.entry_number} className="space-y-2">
                  <h2 className="font-semibold">Entry {entry.entry_number}</h2>
                  <MediaGallery
                    client={client}
                    mediaKeys={entry.media_keys}
                    label={`Anonymous entry ${entry.entry_number} image`}
                  />
                  <form
                    onSubmit={(event) => void saveBallot(event, entry)}
                    className="space-y-3"
                  >
                    {categories.map((category) => (
                      <label key={category.id} className="block">
                        {category.name} (1–{category.max_score})
                        <select
                          required
                          value={ballotScores[entry.entry_number]?.[category.id] || ""}
                          onChange={(event) => {
                            setBallotScores((current) => ({
                              ...current,
                              [entry.entry_number]: {
                                ...current[entry.entry_number],
                                [category.id]: event.target.value,
                              },
                            }));
                            setBallotFeedback((current) => ({
                              ...current,
                              [entry.entry_number]: "",
                            }));
                          }}
                          className="mt-1 block w-full rounded border border-slate-300 p-2"
                        >
                          <option value="">Choose a score</option>
                          {Array.from({ length: category.max_score }, (_, index) => index + 1)
                            .map((score) => <option key={score} value={score}>{score}</option>)}
                        </select>
                      </label>
                    ))}
                    {ballotFeedback[entry.entry_number] && (
                      <p role="status">{ballotFeedback[entry.entry_number]}</p>
                    )}
                    <Button
                      type="submit"
                      disabled={savingBallot !== null || categories.length === 0}
                    >
                      {savingBallot === entry.entry_number
                        ? "Saving ballot…"
                        : "Save ballot"}
                    </Button>
                  </form>
                </li>
              ))}
            </ol>
          ) : <p>No entries are available for blind voting.</p>}
          <p className="mt-4 text-sm text-slate-600">
            Score each category for an entry. Saved ballots can be revised until voting closes.
          </p>
        </Card>
      )}
      {competition.status === "voting" && !votingOpen && (
        <Card title="Voting closed">
          <p>The voting deadline has passed. Preliminary results are not available to members.</p>
        </Card>
      )}
      {competition.status === "review_pending" && (
        <Card title="Voting ended">
          <p>Voting has ended! The administrator is reviewing the results. Please wait for the results to be published.</p>
          {competition.results_publish_at && (
            <p>Results are scheduled to be published {new Date(competition.results_publish_at).toLocaleString()}.</p>
          )}
        </Card>
      )}
      {competition.status === "results_published" && (
        <Card title="Published results">
          {publishedResults.length ? (
            <ol className="space-y-3">
              {publishedResults.map((result) => (
                <li key={`${result.rank}:${result.creator_id}`} className="rounded border border-slate-200 p-3">
                  <h2 className="font-semibold">Rank {result.rank}: {result.title}</h2>
                  <p>Submitted by {result.creator_name || "Participant"}</p>
                  {result.is_disqualified
                    ? <p>Disqualified</p>
                    : <p>{result.score?.toFixed(4) ?? "—"}% · {result.vote_count} complete ballots</p>}
                </li>
              ))}
            </ol>
          ) : <p>No results were published.</p>}
          {publishedCategoryResults.length > 0 && (
            <section className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold">Category winners</h2>
              {[...new Map(publishedCategoryResults.map((result) => [
                result.category_id,
                result.category_name,
              ])).entries()].map(([categoryId, categoryName]) => (
                <section key={categoryId}>
                  <h3 className="font-semibold">{categoryName}</h3>
                  <ol className="list-inside list-decimal">
                    {publishedCategoryResults.filter((result) => result.category_id === categoryId).map((result, index) => (
                      <li key={`${categoryId}:${index}`}>
                        {result.rank === 1 ? "Winner: " : ""}{result.title} ({result.creator_name})
                        {" — "}{result.score.toFixed(4)}%
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </section>
          )}
        </Card>
      )}
      {error && !editable && <p role="alert">{error}</p>}
    </div>
  );
}

export function AdminSubmissions({ competitionId }: { competitionId: string }) {
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
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState("");
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
            .select("id,group_id,name,status,submission_deadline,voting_deadline,results_publish_at,groups(name)")
            .eq("id", competitionId).maybeSingle(),
          client.rpc("get_admin_competition_attendees", { p_competition_id: competitionId }),
          client.rpc("get_competition_participants", { p_competition_id: competitionId }),
        ]);
        if (!active) return;
        if (submissionResult.error) {
          setError(`Unable to load admin submissions: ${submissionResult.error.message}`);
          return;
        }
        if (competitionResult.error || !competitionResult.data) {
          setError(`Unable to load competition status: ${competitionResult.error?.message || "Competition not found."}`);
          return;
        }
        if (attendeeResult.error) {
          setError(`Unable to load competition attendees: ${attendeeResult.error.message}`);
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
          if (review.error) setError(`Unable to load preliminary results: ${review.error.message}`);
          else setReviewResults((review.data || []) as AdminReviewResult[]);
          if (categories.error) setError(`Unable to load category winners: ${categories.error.message}`);
          else setReviewCategories((categories.data || []) as AdminCategoryResult[]);
        }
      } catch {
        if (active) setError("Unable to load admin submissions. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, competitionId, attempt]);

  useRealtimeUpdates(client, session.user.id, groupId, refresh);

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
    if (!step || transitioning || !window.confirm(step.confirm)) return;
    setTransitioning(true);
    setTransitionError("");
    try {
      const { error: transitionFailure } = await client.rpc("transition_competition", {
        p_competition_id: competitionId,
        p_target_status: step.target,
      });
      if (transitionFailure) throw transitionFailure;
      refresh();
    } catch (failure) {
      setTransitionError(`Unable to ${step.action.toLowerCase()}: ${failureMessage(failure)}`);
    } finally {
      setTransitioning(false);
    }
  }

  async function disqualify(entry: AdminReviewResult) {
    const reason = reasons[entry.entry_id]?.trim();
    if (!reason || workingEntry) return;
    const disposition = dispositions[entry.entry_id] || "exclude";
    if (disposition === "remove_content"
      && !window.confirm("Remove this entry's title and private images? The entry and moderation audit remain, but it cannot be reinstated.")) return;
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
          ? { ...item, title: "Content removed", media_keys: [] }
          : item));
        if (submission?.media_keys.length) {
          const { error: removeError } = await client.storage
            .from("competition-submissions")
            .remove(submission.media_keys);
          if (removeError) {
            setPendingMediaCleanup((current) => ({ ...current, [entry.entry_id]: submission.media_keys }));
            cleanupFailure = "The entry was hidden, but private image cleanup failed. Retry cleanup below.";
          }
        }
      }
      await refreshReviewResults();
      setReasons((current) => ({ ...current, [entry.entry_id]: "" }));
      if (cleanupFailure) setError(cleanupFailure);
    } catch (reviewError) {
      setError(`Unable to disqualify entry: ${failureMessage(reviewError)}`);
    } finally {
      setWorkingEntry("");
    }
  }

  async function retryMediaCleanup(entryId: string) {
    const keys = pendingMediaCleanup[entryId];
    if (!keys?.length) return;
    const { error: cleanupError } = await client.storage.from("competition-submissions").remove(keys);
    if (cleanupError) {
      setError(`Unable to remove private images: ${failureMessage(cleanupError)}`);
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
      setError(`Unable to reinstate entry: ${failureMessage(reviewError)}`);
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
      setError(`Unable to save publication schedule: ${failureMessage(scheduleError)}`);
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
      setError(`Unable to publish results: ${failureMessage(publishError)}`);
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return <p role="status">Loading admin submissions…</p>;
  if (error && !competition) return <p role="alert">{error}</p>;
  const step = nextTransition[competitionStatus];

  const attendeeName = (userId: string) =>
    attendees.find((attendee) => attendee.user_id === userId)?.display_name || "Participant";

  return (
    <div className="space-y-6">
      {competition && (
        <Breadcrumbs items={[...competitionCrumbs(competitionId, competition, groupId), { label: "Manage" }]} />
      )}
      <Card title={competition?.name || "Competition status"}>
        <p className="flex flex-wrap items-center gap-2">Status: <StatusBadge status={competitionStatus} /></p>
        {competition && <Deadlines competition={competition} />}
        {competitionStatus === "draft" && (
          <p>Edit the draft from the group page. Opening submissions locks its settings.</p>
        )}
        {competitionStatus === "review_pending" && (
          <>
            <p>Review the preliminary rankings below, then publish the final results.</p>
            <label className="mt-3 block max-w-sm">Schedule results publication
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(event) => setPublishAt(event.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 p-2"
              />
            </label>
            <p className="text-sm text-slate-600">Change the time or leave it blank to cancel the schedule. You can update it any time before publication.</p>
            <Button onClick={() => void saveSchedule()}>Save publication schedule</Button>
          </>
        )}
        {transitionError && <p role="alert">{transitionError}</p>}
        {step && (
          <Button disabled={transitioning} onClick={() => void advance()}>
            {transitioning ? "Updating…" : step.action}
          </Button>
        )}
      </Card>
      <Card title="Competition attendees">
        <p>Group members and anyone who has submitted or voted, with how each takes part in this competition.</p>
        {attendees.length ? (
          <ul className="space-y-3">
            {attendees.map((attendee) => (
              <li key={attendee.user_id} className="rounded border border-slate-200 p-3">
                <p className="break-words font-semibold">{attendee.display_name || "Participant"}</p>
                <p className="text-sm text-slate-600">
                  {attendee.role === "admin" ? "Admin" : attendee.role === "member" ? "Member" : "Former member"}
                  {" · "}{competitionRoles[attendee.user_id] === "participant" ? "Participant"
                    : competitionRoles[attendee.user_id] === "audience" ? "Audience" : "Not taking part"}
                  {" · "}{attendee.has_submission ? "Submitted" : "No submission"}
                  {" · "}{attendee.has_voted ? "Has voted" : "Has not voted"}
                </p>
              </li>
            ))}
          </ul>
        ) : <p>No attendees are involved yet.</p>}
      </Card>
      <Card title="Private submission review">
        {entries.length ? (
          <ul className="space-y-6">
            {entries.map((entry) => (
              <li key={entry.id} className="space-y-2">
                <h2 className="font-semibold">{entry.title}</h2>
                <p className="break-words text-sm text-slate-600">Submitted by {attendeeName(entry.creator_id)}</p>
                <MediaGallery client={client} mediaKeys={entry.media_keys} label="Submission image" />
              </li>
            ))}
          </ul>
        ) : <p>No submissions have been received.</p>}
      </Card>
      {reviewResults && (
        <Card title="Preliminary rankings (admins only)">
          <p>Scores are category-normalized averages. Ties share a rank; only complete ballots count.</p>
          <ul className="space-y-4">
            {reviewResults.map((entry) => (
              <li key={entry.entry_id} className="rounded border border-slate-200 p-4">
                <h2 className="font-semibold">
                  {entry.rank === null ? "Not ranked" : `Rank ${entry.rank}`}: {entry.title}
                </h2>
                <p className="break-words text-sm text-slate-600">Submitted by {attendeeName(entry.creator_id)}</p>
                {!entry.is_disqualified && (
                  <p>{entry.score === null ? "No complete ballots" : `${entry.score.toFixed(4)}%`}
                    {" · "}{entry.vote_count} complete ballots</p>
                )}
                {entry.is_disqualified && (
                  <p>
                    {entry.content_removed ? "Content removed" : `Disqualified (${entry.disqualification_display})`}: {entry.disqualification_reason}
                    {entry.disqualified_by && ` · Admin ${attendeeName(entry.disqualified_by)}`}
                    {entry.disqualified_at && ` · ${new Date(entry.disqualified_at).toLocaleString()}`}
                  </p>
                )}
                {entry.is_disqualified && !entry.content_removed && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="min-w-0 basis-full sm:basis-56 sm:flex-1">Reason for reinstatement
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
                      Reinstate entry
                    </Button>
                  </div>
                )}
                {pendingMediaCleanup[entry.entry_id]?.length > 0 && (
                  <Button onClick={() => void retryMediaCleanup(entry.entry_id)}>
                    Retry private image cleanup
                  </Button>
                )}
                {!entry.is_disqualified && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="min-w-0 basis-full sm:basis-56 sm:flex-1">Disqualification reason
                      <input
                        maxLength={500}
                        value={reasons[entry.entry_id] || ""}
                        onChange={(event) => setReasons((current) => ({
                          ...current, [entry.entry_id]: event.target.value,
                        }))}
                        className="mt-1 block w-full rounded border border-slate-300 p-2"
                      />
                    </label>
                    <label>Result handling
                      <select
                        value={dispositions[entry.entry_id] || "exclude"}
                        onChange={(event) => setDispositions((current) => ({
                          ...current,
                          [entry.entry_id]: event.target.value as "exclude" | "bottom" | "remove_content",
                        }))}
                        className="mt-1 block rounded border border-slate-300 p-2"
                      >
                        <option value="exclude">Exclude from results</option>
                        <option value="bottom">Show as disqualified at bottom</option>
                        <option value="remove_content">Remove inappropriate content</option>
                      </select>
                    </label>
                    <Button
                      disabled={!reasons[entry.entry_id]?.trim() || workingEntry !== ""}
                      onClick={() => void disqualify(entry)}
                    >
                      {workingEntry === entry.entry_id ? "Disqualifying…" : "Disqualify"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {reviewCategories.filter((category) => category.rank === 1).length > 0 && (
            <section className="mt-6 space-y-2">
              <h2 className="text-lg font-semibold">Preliminary category winners</h2>
              {reviewCategories.filter((category) => category.rank === 1).map((winner) => (
                <p key={`${winner.category_id}:${winner.entry_id}`}>
                  {winner.category_name}: {winner.title} ({attendeeName(winner.creator_id)}) — {winner.score.toFixed(4)}%
                </p>
              ))}
            </section>
          )}
          {actionMessage && <p role="status">{actionMessage}</p>}
          <Button disabled={publishing || workingEntry !== ""} onClick={() => void publishResults()}>
            {publishing ? "Publishing…" : "Publish final results"}
          </Button>
        </Card>
      )}
      {competitionStatus === "results_published" && actionMessage && <p role="status">{actionMessage}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
