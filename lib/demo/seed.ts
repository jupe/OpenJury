import { registerSampleObject, type Actor, type DemoDatabase } from "@/lib/demo/client";
import { alex, kai, pat, personas, robin, sam, type Persona } from "@/lib/demo/personas";

/*
 * Fictional starting data. Everything after the accounts goes through the
 * same RPCs and storage rules the app uses, so the seed cannot drift from
 * what the database allows.
 */

const BUCKET = "competition-submissions";
const day = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * day).toISOString();

const actor = (persona: Persona): Actor => ({ id: persona.id, email: persona.email, role: "authenticated" });

export async function seedDemo(database: DemoDatabase) {
  async function call<T>(persona: Persona, name: string, args: Record<string, unknown> = {}) {
    const { data, error } = await database.rpc(actor(persona), name, args);
    if (error) throw new Error(`Demo seed failed in ${name}: ${error.message}`);
    return data as T;
  }

  for (const persona of personas) {
    await database.db.query(
      "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)",
      [persona.id, persona.email, { display_name: persona.name }],
    );
  }
  await database.db.query("insert into public.platform_admins (email) values ($1)", [pat.email]);

  const northside = await call<string>(alex, "create_group", { group_name: "Northside Makers" });
  const riverside = await call<string>(sam, "create_group", { group_name: "Riverside Choir" });
  // Seeded directly: in the app, members arrive through invite links.
  await database.db.query(
    "insert into public.group_members (group_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($5, $3, 'member')",
    [northside, sam.id, robin.id, kai.id, riverside],
  );

  async function competition(name: string, eventType: "live" | "remote", deadlines: [string | null, string | null], categories: [string, number][]) {
    return call<string>(alex, "save_draft_competition", {
      p_competition_id: null,
      p_group_id: northside,
      p_name: name,
      p_event_type: eventType,
      p_submission_deadline: deadlines[0],
      p_voting_deadline: deadlines[1],
      p_categories: categories.map(([category, maxScore]) => ({ name: category, max_score: maxScore })),
    });
  }

  /** Saves an entry with sample photos from public/demo (see CREDITS.md there). */
  async function submit(persona: Persona, competitionId: string, title: string, photos: string[]) {
    const entryId = await call<string>(persona, "save_submission", {
      p_competition_id: competitionId, p_entry_id: null, p_title: title, p_media_keys: [],
    });
    const keys: string[] = [];
    for (const photo of photos) {
      const source = `/demo/${photo}`;
      const response = await fetch(source);
      // A missing photo leaves the entry without it rather than failing the whole demo.
      if (!response.ok) continue;
      const { size } = await response.blob();
      const key = `${competitionId}/${entryId}/${crypto.randomUUID()}.jpg`;
      await registerSampleObject(database, actor(persona), BUCKET, key, source, size);
      keys.push(key);
    }
    if (!keys.length) return;
    await call(persona, "save_submission", {
      p_competition_id: competitionId, p_entry_id: entryId, p_title: title, p_media_keys: keys,
    });
  }

  /** Scores every entry on the voter's blind ballot, highest for the first-listed. */
  async function vote(persona: Persona, competitionId: string, scores: number[][]) {
    const entries = await call<{ entry_number: number }[]>(persona, "get_blind_voting_entries", { p_competition_id: competitionId });
    const { rows: categories } = await database.db.query<{ id: string }>(
      "select id from public.categories where competition_id = $1 order by name", [competitionId],
    );
    for (const [index, entry] of entries.entries()) {
      const row = scores[index % scores.length];
      await call(persona, "save_ballot", {
        p_competition_id: competitionId,
        p_entry_number: entry.entry_number,
        p_scores: categories.map((category, categoryIndex) => ({ category_id: category.id, score: row[categoryIndex] })),
      });
    }
  }

  // Results published: shows the final leaderboard and category winners.
  const photo = await competition("Winter Photo Walk", "remote", [null, null], [["Composition", 5], ["Mood", 5]]);
  await call(alex, "transition_competition", { p_competition_id: photo, p_target_status: "submission" });
  for (const persona of [sam, robin, kai]) await call(persona, "join_competition", { p_competition_id: photo, p_role: "participant" });
  await call(alex, "join_competition", { p_competition_id: photo, p_role: "audience" });
  await submit(sam, photo, "Frosty sunrise", ["frosty-meadow.jpg", "lake-sunrise.jpg"]);
  await submit(robin, photo, "Lanterns over the market lane", ["market-lanterns.jpg"]);
  await submit(kai, photo, "Fox napping in fresh snow", ["fox-in-snow.jpg"]);
  await call(alex, "transition_competition", { p_competition_id: photo, p_target_status: "voting" });
  await vote(alex, photo, [[5, 4], [4, 5], [3, 3]]);
  await call(alex, "transition_competition", { p_competition_id: photo, p_target_status: "review_pending" });
  await call(alex, "publish_competition_results", { p_competition_id: photo });

  // Voting open: Alex and Robin are the audience; Robin has already voted.
  const bakeoff = await competition("Spring Bake-off", "live", [null, inDays(5)], [["Presentation", 5], ["Taste", 5]]);
  await call(alex, "transition_competition", { p_competition_id: bakeoff, p_target_status: "submission" });
  for (const persona of [sam, kai]) await call(persona, "join_competition", { p_competition_id: bakeoff, p_role: "participant" });
  for (const persona of [alex, robin]) await call(persona, "join_competition", { p_competition_id: bakeoff, p_role: "audience" });
  await submit(sam, bakeoff, "Rhubarb custard tart", ["rhubarb-tart.jpg", "rhubarb-tart-slice.jpg"]);
  await submit(kai, bakeoff, "Lemon layer cake", ["lemon-layer-cake.jpg"]);
  await call(alex, "transition_competition", { p_competition_id: bakeoff, p_target_status: "voting" });
  await vote(robin, bakeoff, [[4, 5], [5, 3]]);

  // Submissions open: Sam has an entry, Robin joined without one yet.
  const garden = await competition("Summer Garden Show", "remote", [inDays(7), inDays(14)], [["Colour", 5], ["Creativity", 5], ["Care", 3]]);
  await call(alex, "transition_competition", { p_competition_id: garden, p_target_status: "submission" });
  await call(sam, "join_competition", { p_competition_id: garden, p_role: "participant" });
  await call(robin, "join_competition", { p_competition_id: garden, p_role: "participant" });
  await submit(sam, garden, "Flower-filled balcony", ["flower-balcony.jpg"]);

  // Draft: only admins see it until submissions open.
  await competition("Autumn Karaoke Night", "live", [inDays(20), inDays(21)], [["Vocals", 5], ["Stage presence", 5]]);
}

