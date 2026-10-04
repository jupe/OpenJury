"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import Card from "@/components/Card";

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
};

type Submission = { id: string; title: string; media_keys: string[] };
type BlindEntry = { entry_number: number; media_keys: string[] };
type AdminEntry = { id: string; creator_id: string; title: string; media_keys: string[] };
type Category = { id: string; name: string; max_score: number };
type SavedScore = { entry_number: number; category_id: string; score: number };

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
  const keyList = mediaKeys.join("\n");

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    void (async () => {
      try {
        await Promise.resolve();
        if (active) setError("");
        const downloaded = await Promise.all(
          keyList ? keyList.split("\n").map(async (key) => {
            const { data, error: downloadError } = await client.storage
              .from("competition-submissions")
              .download(key);
            if (downloadError) throw downloadError;
            const url = URL.createObjectURL(data);
            urls.push(url);
            return { key, url };
          }) : [],
        );
        if (active) setImages(downloaded);
      } catch {
        if (active) setError("Some private media could not be loaded.");
      }
    })();
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [client, keyList]);

  return (
    <>
      {error && mediaKeys.length > 0 && <p role="alert">{error}</p>}
      {images.some(({ key }) => mediaKeys.includes(key)) && (
        <div className="flex flex-wrap gap-3">
          {images.filter(({ key }) => mediaKeys.includes(key)).map(({ key, url }, index) => (
            <Image
              key={key}
              src={url}
              alt={`${label} ${index + 1}`}
              width={128}
              height={128}
              unoptimized
              className="h-32 w-32 rounded object-cover"
            />
          ))}
        </div>
      )}
    </>
  );
}

export function EntryWorkspace({ competitionId }: { competitionId: string }) {
  const { client, session } = useAuth();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [blindEntries, setBlindEntries] = useState<BlindEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ballotScores, setBallotScores] = useState<Record<number, Record<string, string>>>({});
  const [ballotFeedback, setBallotFeedback] = useState<Record<number, string>>({});
  const [savingBallot, setSavingBallot] = useState<number | null>(null);
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
    try {
      const result = await client.from("competitions")
        .select("id,name,status,submission_deadline,voting_deadline")
        .eq("id", competitionId)
        .maybeSingle();
      if (result.error || !result.data) {
        setError(result.error?.message || "Competition not found or access denied.");
        return;
      }
      setCompetition(result.data);
      setSubmissionOpen(result.data.status === "submission"
        && (!result.data.submission_deadline
          || Date.parse(result.data.submission_deadline) > Date.now()));
      const isVotingOpen = result.data.status === "voting"
        && (!result.data.voting_deadline
          || Date.parse(result.data.voting_deadline) > Date.now());
      setVotingOpen(isVotingOpen);
      const [mine, blind, categoryResult, savedBallot] = await Promise.all([
        client.rpc("get_my_submission", { p_competition_id: competitionId }),
        isVotingOpen
          ? client.rpc("get_blind_voting_entries", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
        isVotingOpen
          ? client.from("categories").select("id,name,max_score")
            .eq("competition_id", competitionId).order("name")
          : Promise.resolve({ data: [], error: null }),
        isVotingOpen
          ? client.rpc("get_my_ballot", { p_competition_id: competitionId })
          : Promise.resolve({ data: [], error: null }),
      ]);
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
      setBlindEntries((blind.data || []) as BlindEntry[]);
      setCategories((categoryResult.data || []) as Category[]);
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
  }, [client, competitionId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, session.user.id]);

  const editable = competition?.status === "submission" && submissionOpen;
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
      <Card title={competition.name}>
        <p>Status: {competition.status}</p>
        {competition.submission_deadline && (
          <p>Submissions close {new Date(competition.submission_deadline).toLocaleString()}</p>
        )}
        {competition.voting_deadline && (
          <p>Voting closes {new Date(competition.voting_deadline).toLocaleString()}</p>
        )}
      </Card>

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

      {competition.status === "voting" && votingOpen && (
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
            Score each category for an entry. Your own entry is excluded; saved ballots can be revised until voting closes.
          </p>
        </Card>
      )}
      {competition.status === "voting" && !votingOpen && (
        <Card title="Voting closed">
          <p>The voting deadline has passed. Preliminary results are not available to members.</p>
        </Card>
      )}
      {error && !editable && <p role="alert">{error}</p>}
    </div>
  );
}

export function AdminSubmissions({ competitionId }: { competitionId: string }) {
  const { client } = useAuth();
  const [entries, setEntries] = useState<AdminEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error: queryError } = await client.rpc("get_admin_submissions", {
          p_competition_id: competitionId,
        });
        if (!active) return;
        if (queryError) setError(`Unable to load admin submissions: ${queryError.message}`);
        else setEntries((data || []) as AdminEntry[]);
      } catch {
        if (active) setError("Unable to load admin submissions. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client, competitionId]);

  if (loading) return <p role="status">Loading admin submissions…</p>;
  if (error) return <p role="alert">{error}</p>;

  return (
    <Card title="Private submission review">
      {entries.length ? (
        <ul className="space-y-6">
          {entries.map((entry) => (
            <li key={entry.id} className="space-y-2">
              <h2 className="font-semibold">{entry.title}</h2>
              <p className="break-all text-sm text-slate-600">Submitted by {entry.creator_id}</p>
              <MediaGallery client={client} mediaKeys={entry.media_keys} label="Submission image" />
            </li>
          ))}
        </ul>
      ) : <p>No submissions have been received.</p>}
    </Card>
  );
}
