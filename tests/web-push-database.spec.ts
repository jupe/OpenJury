import { expect, test } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { pushSender } from "../lib/web-push";

test("web push database ownership, lifecycle, leases, backoff and revocation", async () => {
  test.setTimeout(120_000);
  const db = await PGlite.create();
  const keys = pushSender.generateVAPIDKeys();
  const auth = Buffer.alloc(16, 1).toString("base64url");
  const admin = "00000000-0000-4000-8000-000000000001";
  const member = "00000000-0000-4000-8000-000000000002";
  const outsider = "00000000-0000-4000-8000-000000000003";
  const group = "00000000-0000-4000-8000-000000000010";
  const competition = "00000000-0000-4000-8000-000000000020";
  const endpoint = "https://fcm.googleapis.com/fcm/send/first";
  const actor = async (id: string, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec(`set role ${role}`);
  };
  const save = (url = endpoint) => db.query("select public.save_my_push_subscription($1,$2,$3,'fi')", [url, keys.publicKey, auth]);
  const claim = async () => (await db.query<{ id: string; claim_token: string; event_id: string; phase: string; subscription: unknown }>(
    "select * from public.claim_competition_push($1)", [competition])).rows[0];
  try {
    await db.exec(await readFile("lib/demo/supabaseShim.sql", "utf8"));
    for (const name of (await readdir("supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(`supabase/migrations/${name}`, "utf8"));
    }
    await db.exec(await readFile("supabase/tests/competition_start_notifications.sql", "utf8"));
    await db.exec(`
      insert into auth.users(id,email) values ('${admin}','admin@example.com'),('${member}','member@example.com'),('${outsider}','other@example.com');
      insert into public.groups(id,name,created_by) values ('${group}','Private group','${admin}');
      insert into public.group_members(group_id,user_id,role) values ('${group}','${admin}','admin'),('${group}','${member}','member');
      insert into public.competitions(id,group_id,name,event_type) values ('${competition}','${group}','Private name','live');
    `);
    await actor(member);
    await save();
    await save("https://fcm.googleapis.com/wp/second");
    await db.query("select public.delete_my_push_subscription($1)", ["https://fcm.googleapis.com/wp/second"]);
    await expect(db.query("select * from public.web_push_subscriptions")).rejects.toThrow();
    await expect(claim()).rejects.toThrow();
    await expect(db.query("select * from public.pending_competition_push_dispatch()")).rejects.toThrow();
    await expect(db.query("select public.authorize_competition_push($1)", [competition])).rejects.toThrow();
    await expect(db.query("select public.get_my_pending_competition_push($1)", [competition])).rejects.toThrow();
    await actor(outsider);
    await expect(save()).rejects.toThrow("Endpoint unavailable");
    await db.query("select public.delete_my_push_subscription($1)", [endpoint]);
    await actor(member);
    for (let i = 2; i <= 5; i++) await save(`https://web.push.apple.com/${i}`);
    await expect(save("https://web.push.apple.com/6")).rejects.toThrow("Subscription limit");
    await save();
    for (const url of ["https://evil.test/x", "https://web.push.apple.com:8443/x", "https://user@web.push.apple.com/x", "https://push.apple.com/x",
      "https://fcm.googleapis.com.evil.test/fcm/send/x", "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user@fcm.googleapis.com/wp/x", "https://fcm.googleapis.com/other/x", "https://fcm.googleapis.com/wp/"]) {
      await expect(save(url)).rejects.toThrow("Invalid subscription");
    }
    await db.exec("reset role");
    await db.exec(`delete from public.web_push_subscriptions where endpoint <> '${endpoint}'`);
    await actor(admin);
    await db.query("select public.authorize_competition_push($1)", [competition]);
    expect((await db.query("select public.get_my_pending_competition_push($1) pending", [competition])).rows[0]).toEqual({ pending: false });
    await db.query("select public.transition_competition($1,'submission')", [competition]);
    expect((await db.query("select public.get_my_pending_competition_push($1) pending", [competition])).rows[0]).toEqual({ pending: true });
    await actor(admin, "service_role");
    await expect(db.query("select * from public.web_push_subscriptions")).rejects.toThrow();
    expect((await db.query("select * from public.pending_competition_push_dispatch()")).rows).toEqual([{ competition_id: competition }]);
    const first = await claim();
    expect(first.phase).toBe("submission");
    expect(first.subscription).toEqual({ endpoint, keys: { p256dh: keys.publicKey, auth } });
    expect(await claim()).toBeUndefined();
    expect((await db.query("select public.finish_competition_push($1,$2,'sent') ok", [first.id, outsider])).rows[0]).toEqual({ ok: false });
    await db.query("select public.finish_competition_push($1,$2,'retry')", [first.id, first.claim_token]);
    await actor(admin);
    expect((await db.query("select public.get_my_pending_competition_push($1) pending", [competition])).rows[0]).toEqual({ pending: true });
    await actor(admin, "service_role");
    expect(await claim()).toBeUndefined();
    expect((await db.query("select public.competition_push_sent($1) ok", [competition])).rows[0]).toEqual({ ok: false });
    await db.exec("reset role");
    await db.exec("update public.competition_push_outbox set next_attempt_at = now() - interval '1 second'");
    await actor(admin, "service_role");
    const second = await claim();
    expect(second.claim_token).not.toBe(first.claim_token);
    await actor(member);
    await save();
    await actor(admin, "service_role");
    expect((await db.query("select public.competition_push_claim_active($1,$2) ok", [second.id, second.claim_token])).rows[0]).toEqual({ ok: false });
    await db.query("select public.finish_competition_push($1,$2,'skipped')", [second.id, second.claim_token]);
    await db.exec("reset role");
    expect((await db.query("select count(*)::int n from public.web_push_subscriptions")).rows[0]).toEqual({ n: 1 });
    expect((await db.query("select finished_at is null pending from public.competition_push_outbox where id=$1",
      [second.id])).rows[0]).toEqual({ pending: true });
    await db.exec("update public.competition_push_outbox set next_attempt_at = now() - interval '1 second'");
    await actor(admin, "service_role");
    const third = await claim();
    expect(third.event_id).toBe(second.event_id);
    await actor(member);
    const refreshedAuth = Buffer.alloc(16, 2).toString("base64url");
    await db.query("select public.save_my_push_subscription($1,$2,$3,'fi')", [endpoint, keys.publicKey, refreshedAuth]);
    await actor(admin, "service_role");
    await db.query("select public.finish_competition_push($1,$2,'sent')", [third.id, third.claim_token]);
    expect((await db.query("select public.competition_push_sent($1) ok", [competition])).rows[0]).toEqual({ ok: false });
    await db.exec("reset role");
    await db.exec("update public.competition_push_outbox set next_attempt_at = now() - interval '1 second'");
    await actor(admin, "service_role");
    const refreshed = await claim();
    expect(refreshed.subscription).toEqual({ endpoint, keys: { p256dh: keys.publicKey, auth: refreshedAuth } });
    await actor(member);
    await save();
    await actor(admin, "service_role");
    await db.query("select public.finish_competition_push($1,$2,'expired')", [refreshed.id, refreshed.claim_token]);
    await db.exec("reset role");
    expect((await db.query("select count(*)::int n from public.web_push_subscriptions")).rows[0]).toEqual({ n: 1 });
    await db.exec("update public.competition_push_outbox set next_attempt_at = now() - interval '1 second'");
    await actor(admin, "service_role");
    const revoked = await claim();
    await db.exec("reset role");
    await db.exec(`delete from public.group_members where user_id = '${member}'`);
    await actor(admin, "service_role");
    expect((await db.query("select public.competition_push_claim_active($1,$2) ok", [revoked.id, revoked.claim_token])).rows[0]).toEqual({ ok: false });
    expect(await claim()).toBeUndefined();
    expect((await db.query("select public.competition_push_sent($1) ok", [competition])).rows[0]).toEqual({ ok: true });
    await db.exec("reset role");
    await db.exec(`insert into public.group_members(group_id,user_id) values ('${group}','${member}')`);
    // Owner fixture updates isolate trigger coverage from unrelated lifecycle preconditions.
    await db.exec(`update public.competitions set status = 'voting' where id = '${competition}'`);
    await actor(admin, "service_role");
    const voting = await claim();
    expect(voting.phase).toBe("voting");
    await db.exec("reset role");
    await db.exec("update public.competition_push_outbox set claimed_until = now() - interval '1 second' where finished_at is null");
    await actor(admin, "service_role");
    const reclaimed = await claim();
    expect(reclaimed.id).toBe(voting.id);
    expect(reclaimed.claim_token).not.toBe(voting.claim_token);
    await db.query("select public.finish_competition_push($1,$2,'sent')", [reclaimed.id, reclaimed.claim_token]);
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'results_published' where id = '${competition}'`);
    await actor(admin, "service_role");
    const published = await claim();
    expect(published.phase).toBe("results_published");
    await db.query("select public.finish_competition_push($1,$2,'expired')", [published.id, published.claim_token]);
    expect((await db.query("select public.competition_push_sent($1) ok", [competition])).rows[0]).toEqual({ ok: true });
    await db.exec("reset role");
    expect((await db.query("select count(*)::int n from public.web_push_subscriptions")).rows[0]).toEqual({ n: 0 });
    await actor(member);
    await save();
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'submission' where id = '${competition}'`);
    await actor(member);
    await db.query("select public.delete_my_push_subscription($1)", [endpoint]);
    await actor(admin, "service_role");
    expect(await claim()).toBeUndefined();
    expect((await db.query("select public.competition_push_sent($1) ok", [competition])).rows[0]).toEqual({ ok: true });
    await actor(member);
    await save();
    await db.exec("reset role");
    await db.exec(`update public.competitions set event_type = 'remote',
      submission_deadline = now() - interval '1 minute', voting_deadline = now() + interval '1 hour'
      where id = '${competition}'`);
    await actor(admin, "service_role");
    await db.query("select public.process_remote_competition_deadlines()");
    expect((await claim()).phase).toBe("voting");
    expect((await db.query("select public.all_competition_push_sent() ok")).rows[0]).toEqual({ ok: false });
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'results_published' where id = '${competition}'`);
    await actor(admin, "service_role");
    const withdrawn = await claim();
    expect(withdrawn.phase).toBe("results_published");
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'review_pending' where id = '${competition}'`);
    await actor(admin, "service_role");
    expect((await db.query("select public.competition_push_claim_active($1,$2) ok",
      [withdrawn.id, withdrawn.claim_token])).rows[0]).toEqual({ ok: false });
    expect((await db.query("select public.finish_competition_push($1,$2,'sent') ok",
      [withdrawn.id, withdrawn.claim_token])).rows[0]).toEqual({ ok: false });
    expect(await claim()).toBeUndefined();
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'results_published' where id = '${competition}'`);
    await actor(admin, "service_role");
    const reopened = await claim();
    expect(reopened.event_id).not.toBe(withdrawn.event_id);
    expect(reopened.phase).toBe("results_published");
    await db.exec("reset role");
    await db.exec(`update public.competitions set status = 'submission' where id = '${competition}'`);
    await actor(admin, "service_role");
    expect((await claim()).phase).toBe("submission");
  } finally {
    await db.close();
  }
});
