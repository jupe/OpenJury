import { expect, test } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const competition = uuid(20);
type Status = { phase: string | null; recipient_count: number; next_allowed_at: Date | null };
type Claim = {
  id: string;
  claim_token: string;
  phase: string;
  kind: string;
  competition_name: string;
  subscription: { endpoint: string };
};

async function fixture() {
  const db = await PGlite.create();
  await db.exec(await readFile("lib/demo/supabaseShim.sql", "utf8"));
  for (const name of (await readdir("supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`supabase/migrations/${name}`, "utf8"));
  }
  const actor = async (n: number, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [n ? uuid(n) : ""]);
    await db.exec(`set role ${role}`);
  };
  const owner = async (sql: string) => {
    await db.exec("reset role");
    await db.exec(sql);
    await actor(1);
  };
  await db.exec(`
    insert into auth.users(id,email)
      select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        'user' || n || '@example.com' from generate_series(1,9) n;
    insert into public.groups(id,name,created_by) values
      ('${uuid(10)}','Reminder group','${uuid(1)}'),
      ('${uuid(11)}','Other group','${uuid(1)}');
    insert into public.group_members(group_id,user_id,role)
      select '${uuid(10)}', id, case when id in ('${uuid(1)}','${uuid(2)}') then 'admin' else 'member' end
        from auth.users where id <> '${uuid(9)}';
    insert into public.group_members(group_id,user_id,role) values
      ('${uuid(11)}','${uuid(1)}','admin'), ('${uuid(11)}','${uuid(3)}','member');
    insert into public.competitions(id,group_id,name,event_type,status,submission_deadline,voting_deadline) values
      ('${competition}','${uuid(10)}','Reminder competition','remote','submission',now()+interval '2 hours',now()+interval '3 hours'),
      ('${uuid(21)}','${uuid(10)}','Same group competition','remote','submission',now()+interval '2 hours',now()+interval '3 hours'),
      ('${uuid(22)}','${uuid(11)}','Other group competition','remote','submission',now()+interval '2 hours',now()+interval '3 hours');
    insert into public.competition_participants(competition_id,user_id,role) values
      ('${competition}','${uuid(4)}','participant'), ('${competition}','${uuid(5)}','participant'),
      ('${competition}','${uuid(6)}','audience'), ('${competition}','${uuid(7)}','audience');
    insert into public.categories(id,competition_id,name) values
      ('${uuid(30)}','${competition}','Taste'), ('${uuid(31)}','${competition}','Presentation');
    insert into public.entries(id,competition_id,creator_id,title) values
      ('${uuid(40)}','${competition}','${uuid(5)}','Submitted');
  `);
  const key = Buffer.alloc(65, 1);
  key[0] = 4;
  for (const n of [1, 3, 4, 5, 6, 7, 9]) {
    await actor(n);
    await db.query("select public.save_my_push_subscription($1,$2,$3,'en')", [
      `https://fcm.googleapis.com/wp/user${n}`, key.toString("base64url"), Buffer.alloc(16, 1).toString("base64url"),
    ]);
  }
  await actor(3);
  await db.query("select public.save_my_push_subscription($1,$2,$3,'fi')", [
    "https://fcm.googleapis.com/wp/user3second", key.toString("base64url"), Buffer.alloc(16, 1).toString("base64url"),
  ]);
  await actor(1);
  const status = async (id = competition) =>
    (await db.query<Status>("select * from public.get_competition_reminder_status($1)", [id])).rows[0];
  const queue = async (id = competition) =>
    (await db.query<Status>("select * from public.queue_competition_reminder($1)", [id])).rows[0];
  const claim = async (id = competition) =>
    (await db.query<Claim>("select * from public.claim_competition_push($1)", [id])).rows[0];
  const active = async (claimed: Claim) =>
    (await db.query<{ active: boolean }>("select public.competition_push_claim_active($1,$2) active",
      [claimed.id, claimed.claim_token])).rows[0].active;
  const recipients = async () => {
    await db.exec("reset role");
    const rows = (await db.query<{ user_id: string }>(`
      select distinct subscription.user_id
      from public.competition_push_outbox outbox
      join public.competition_push_events event on event.id = outbox.event_id
      join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
      where event.competition_id = $1 and event.kind = 'reminder' and outbox.finished_at is null
      order by subscription.user_id`, [competition])).rows;
    await actor(1);
    return rows.map((row) => row.user_id);
  };
  return { db, actor, owner, status, queue, claim, active, recipients };
}

test("reminders authorize admins, keep history private, target submission work and recheck delivery", async () => {
  test.setTimeout(120_000);
  const { db, actor, owner, status, queue, claim, active, recipients } = await fixture();
  try {
    for (const n of [0, 3, 9]) {
      await actor(n);
      await expect(status()).rejects.toThrow("administrator access required");
      await expect(queue()).rejects.toThrow("administrator access required");
    }
    await actor(0, "anon");
    await expect(status()).rejects.toThrow("permission denied");
    await expect(queue()).rejects.toThrow("permission denied");
    for (const role of ["authenticated", "anon", "service_role"]) {
      await actor(1, role);
      await expect(db.query("select * from public.competition_reminder_history")).rejects.toThrow("permission denied");
      await expect(db.exec(`insert into public.competition_reminder_history(group_id) values ('${uuid(10)}')`))
        .rejects.toThrow("permission denied");
    }
    await actor(1);
    await expect(db.query("select public.competition_reminder_recipient($1,$2,$3)",
      [competition, uuid(3), uuid(1)])).rejects.toThrow("permission denied");
    await expect(db.query("select public.competition_reminder_next_allowed($1,$2)",
      [competition, uuid(10)])).rejects.toThrow("permission denied");
    // A member whose previous enrollment was removed still needs an invitation to join.
    await owner(`insert into public.entries(competition_id,creator_id,title,is_disqualified)
      values ('${competition}','${uuid(3)}','Previous enrollment',true)`);
    expect(await status()).toEqual({ phase: "submission", recipient_count: 2, next_allowed_at: null });
    const queued = await queue();
    expect(queued.recipient_count).toBe(2);
    expect(queued.next_allowed_at).not.toBeNull();
    expect(await recipients()).toEqual([uuid(3), uuid(4)]);
    // The unjoined user has two devices, but counts as one recipient.
    await db.exec("reset role");
    expect((await db.query<{ n: number }>("select count(*)::int n from public.competition_push_outbox")).rows[0].n).toBe(3);
    await actor(1, "service_role");
    const claimed = await claim();
    expect(claimed).toMatchObject({ kind: "reminder", phase: "submission", competition_name: "Reminder competition" });
    expect(await active(claimed)).toBe(true);
    // Joining as jury or submitting eliminates all pending reminders, including leased work.
    await owner(`
      insert into public.competition_participants(competition_id,user_id,role)
        values ('${competition}','${uuid(3)}','audience');
      insert into public.entries(competition_id,creator_id,title)
        values ('${competition}','${uuid(4)}','Just submitted');
    `);
    await actor(1, "service_role");
    expect(await active(claimed)).toBe(false);
    expect(await claim()).toBeUndefined();
    await actor(1);
    expect((await status()).recipient_count).toBe(0);
    await expect(queue()).rejects.toThrow("cooldown");
    await db.exec("reset role");
    expect((await db.query<{ n: number }>("select count(*)::int n from public.competition_reminder_history")).rows[0].n).toBe(1);
    expect((await db.query<{ enabled: boolean }>(
      "select relrowsecurity enabled from pg_class where oid='public.competition_reminder_history'::regclass")).rows[0].enabled).toBe(true);
    expect((await db.query<{ n: number }>(
      "select count(*)::int n from public.competition_push_outbox where finished_at is null")).rows[0].n).toBe(0);
    await owner(`
      update public.competition_reminder_history set created_at=now()-interval '25 hours';
      update public.competitions set status='results_published' where id='${competition}';
    `);
    await db.exec("reset role");
    expect((await db.query<{ kind: string }>(
      "select kind from public.competition_push_events where phase='results_published'")).rows[0].kind).toBe("phase");
    await actor(1);
    // Results include unjoined, jury and already-submitted members, but not the actor or outsiders.
    expect((await queue()).recipient_count).toBe(5);
    expect(await recipients()).toEqual([uuid(3), uuid(4), uuid(5), uuid(6), uuid(7)]);
  } finally {
    await db.close();
  }
});

test("voting reminders match progress eligibility across entries, categories, own entries and participant voting", async () => {
  test.setTimeout(120_000);
  const { db, actor, owner, status, queue, claim, active, recipients } = await fixture();
  try {
    await owner(`
      update public.competitions set status='voting', allow_participant_voting=false where id='${competition}';
      delete from public.competition_push_events;
      insert into public.entries(id,competition_id,creator_id,title,is_disqualified) values
        ('${uuid(41)}','${competition}','${uuid(4)}','Own entry',false),
        ('${uuid(42)}','${competition}','${uuid(3)}','Disqualified',true);
      insert into public.votes(entry_id,voter_id,category_id,score)
        select entry.id, '${uuid(7)}', category.id, 3
        from public.entries entry cross join public.categories category
        where entry.competition_id='${competition}' and not entry.is_disqualified;
      insert into public.votes(entry_id,voter_id,category_id,score) values
        ('${uuid(40)}','${uuid(4)}','${uuid(30)}',3),
        ('${uuid(41)}','${uuid(5)}','${uuid(30)}',3),
        ('${uuid(41)}','${uuid(5)}','${uuid(31)}',3);
    `);
    expect((await status()).recipient_count).toBe(1);
    await owner(`update public.competitions set allow_participant_voting=true where id='${competition}'`);
    expect((await status()).recipient_count).toBe(2);
    expect((await db.query("select * from public.get_admin_competition_participation_progress($1)",
      [competition])).rows[0]).toMatchObject({ eligible_voter_count: 4, complete_ballot_count: 2 });
    expect((await queue()).recipient_count).toBe(2);
    expect(await recipients()).toEqual([uuid(4), uuid(6)]);
    await actor(1, "service_role");
    const claimed = await claim();
    expect(await active(claimed)).toBe(true);
    await owner(`
      insert into public.votes(entry_id,voter_id,category_id,score)
        select entry.id, voter.user_id, category.id, 3
        from public.entries entry cross join public.categories category
        cross join (values ('${uuid(4)}'::uuid),('${uuid(6)}'::uuid)) voter(user_id)
        where entry.competition_id='${competition}' and not entry.is_disqualified
          and entry.creator_id <> voter.user_id
        on conflict(entry_id,voter_id,category_id) do nothing;
    `);
    await actor(1, "service_role");
    expect(await active(claimed)).toBe(false);
    expect(await claim()).toBeUndefined();
    await actor(1);
    expect((await status()).recipient_count).toBe(0);
    // No qualified other entry or no category means there is no work to remind.
    await owner(`delete from public.votes; update public.entries set is_disqualified=true where id='${uuid(40)}'`);
    expect((await status()).recipient_count).toBe(3); // Both jury members and the other entry's creator only.
    await owner(`delete from public.categories where competition_id='${competition}'`);
    expect((await status()).recipient_count).toBe(0);
  } finally {
    await db.close();
  }
});

test("persistent rolling and group limits survive admins, phase changes, delivery and competition deletion", async () => {
  test.setTimeout(120_000);
  const { db, actor, owner, status, queue, claim, active } = await fixture();
  try {
    // No-recipient and rejected attempts do not create history or events.
    await owner(`delete from public.web_push_subscriptions`);
    await expect(queue()).rejects.toMatchObject({ code: "22023" });
    await db.exec("reset role");
    expect((await db.query<{ n: number }>("select count(*)::int n from public.competition_reminder_history")).rows[0].n).toBe(0);
    await owner(`update public.competitions set status='draft' where id='${competition}'`);
    expect(await status()).toEqual({ phase: null, recipient_count: 0, next_allowed_at: null });
    await expect(queue()).rejects.toMatchObject({ code: "22023" });
    await owner(`update public.competitions set status='review_pending' where id='${competition}'`);
    expect(await status()).toEqual({ phase: null, recipient_count: 0, next_allowed_at: null });
    await expect(queue()).rejects.toMatchObject({ code: "22023" });
    await owner(`
      update public.competitions set status='submission', submission_deadline=now()-interval '1 second' where id='${competition}';
    `);
    expect(await status()).toEqual({ phase: null, recipient_count: 0, next_allowed_at: null });
    await expect(queue()).rejects.toMatchObject({ code: "22023" });
    await owner(`update public.competitions set submission_deadline=null where id='${competition}'`);
    expect(await status()).toEqual({ phase: null, recipient_count: 0, next_allowed_at: null });
    await owner(`update public.competitions set event_type='live' where id='${competition}'`);
    expect((await status()).recipient_count).toBe(0);
    await owner(`update public.competitions set status='voting', voting_deadline=now()-interval '1 second' where id='${competition}'`);
    expect(await status()).toEqual({ phase: null, recipient_count: 0, next_allowed_at: null });
    await expect(queue()).rejects.toMatchObject({ code: "22023" });
    await owner(`update public.competitions set status='results_published' where id='${competition}'`);
    await db.exec("reset role");
    expect((await db.query<{ n: number }>(
      "select count(*)::int n from public.competition_reminder_history")).rows[0].n).toBe(0);
    await actor(1);
    const key = Buffer.alloc(65, 1);
    key[0] = 4;
    await actor(3);
    await db.query("select public.save_my_push_subscription($1,$2,$3,'en')", [
      "https://fcm.googleapis.com/wp/new", key.toString("base64url"), Buffer.alloc(16, 1).toString("base64url"),
    ]);
    await actor(1);
    // Automatic phase events don't consume the manual cooldown.
    expect((await status()).next_allowed_at).toBeNull();
    await queue();
    await actor(2);
    expect((await status()).phase).toBe("results_published");
    await expect(queue()).rejects.toMatchObject({ code: "54000" });
    await expect(queue(uuid(21))).rejects.toThrow("cooldown");
    await actor(1);
    expect((await queue(uuid(22))).recipient_count).toBe(1); // Different groups are independent.
    await actor(1, "service_role");
    const claimed = await claim();
    await db.query("select public.finish_competition_push($1,$2,'sent')", [claimed.id, claimed.claim_token]);
    await actor(1);
    await expect(queue()).rejects.toThrow("cooldown");
    await owner(`update public.competition_reminder_history set created_at=now()-interval '16 minutes' where group_id='${uuid(10)}'`);
    await actor(2);
    expect((await queue(uuid(21))).recipient_count).toBe(1);
    await actor(1);
    await expect(queue()).rejects.toThrow("cooldown");
    await owner(`
      update public.competition_reminder_history set created_at=now()-interval '2 hours' where competition_id='${competition}';
      update public.competition_reminder_history set created_at=now()-interval '16 minutes' where competition_id='${uuid(21)}';
      update public.competitions set status='submission', submission_deadline=now()+interval '2 hours',
        voting_deadline=now()+interval '3 hours' where id='${competition}';
    `);
    await queue();
    await owner(`update public.competition_reminder_history set created_at=now()-interval '2 hours' where group_id='${uuid(10)}'`);
    await queue();
    await owner(`update public.competition_reminder_history set created_at=now()-interval '2 hours' where group_id='${uuid(10)}'`);
    const capped = await status();
    expect(new Date(capped.next_allowed_at!).getTime() - Date.now()).toBeGreaterThan(21 * 60 * 60 * 1000);
    await actor(2);
    await expect(queue()).rejects.toThrow("cooldown");
    await owner(`update public.competitions set status='voting' where id='${competition}'`);
    await expect(queue()).rejects.toThrow("cooldown"); // Same competition cap spans phases.
    await owner(`update public.competitions set status='results_published' where id='${competition}'`);
    await expect(queue()).rejects.toThrow("cooldown");
    await owner(`update public.competition_reminder_history set created_at=now()-interval '25 hours' where group_id='${uuid(10)}'`);
    expect((await status()).next_allowed_at).toBeNull();
    await queue();
    await actor(1, "service_role");
    const phaseClaim = await claim();
    await owner(`update public.competitions set status='review_pending' where id='${competition}'`);
    await actor(1, "service_role");
    expect(await active(phaseClaim)).toBe(false);
    expect((await db.query<{ ok: boolean }>("select public.finish_competition_push($1,$2,'sent') ok",
      [phaseClaim.id, phaseClaim.claim_token])).rows[0].ok).toBe(false);
    expect(await claim()).toBeUndefined();
    await owner(`delete from public.competitions where id='${competition}'`);
    await expect(queue(uuid(21))).rejects.toThrow("cooldown"); // Deletion does not erase the group cap.
  } finally {
    await db.close();
  }
});
