import { expect, test } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";

test("account deletion authorizes owners and platform admins and removes personal data", async () => {
  test.setTimeout(120_000);
  const db = await PGlite.create();
  const admin = "00000000-0000-4000-8000-000000000001";
  const member = "00000000-0000-4000-8000-000000000002";
  const outsider = "00000000-0000-4000-8000-000000000003";
  const group = "00000000-0000-4000-8000-000000000010";
  const competition = "00000000-0000-4000-8000-000000000020";
  const entry = "00000000-0000-4000-8000-000000000030";
  const otherEntry = "00000000-0000-4000-8000-000000000031";
  const category = "00000000-0000-4000-8000-000000000040";
  const actor = async (id: string, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec(`set role ${role}`);
  };
  try {
    await db.exec(await readFile("lib/demo/supabaseShim.sql", "utf8"));
    for (const name of (await readdir("supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(`supabase/migrations/${name}`, "utf8"));
    }
    await db.exec(`
      insert into auth.users(id,email,last_sign_in_at) values
        ('${admin}','admin@example.com',now()),('${member}','member@example.com',now()),('${outsider}','other@example.com',null);
      insert into public.platform_admins values ('admin@example.com');
      insert into public.groups(id,name,created_by) values ('${group}','Shared group','${member}');
      insert into public.group_members values ('${group}','${member}','admin'),('${group}','${outsider}','member');
      insert into public.competitions(id,group_id,name,event_type) values ('${competition}','${group}','Shared competition','live');
      insert into public.categories(id,competition_id,name) values ('${category}','${competition}','Quality');
      insert into public.entries(id,competition_id,creator_id,title) values
        ('${entry}','${competition}','${member}','Private entry'),('${otherEntry}','${competition}','${outsider}','Retained entry');
      insert into public.votes(entry_id,voter_id,category_id,score) values
        ('${entry}','${outsider}','${category}',3),('${otherEntry}','${member}','${category}',4);
      insert into public.entry_disqualification_events(entry_id,actor_id,reason) values
        ('${entry}','${admin}','Private reason'),('${otherEntry}','${member}','Personal reason');
      insert into public.published_competition_results(competition_id,entry_id,rank,score,vote_count,title,creator_id)
        values ('${competition}','${entry}',1,3,1,'Private title','${member}');
      insert into public.competition_participants values ('${competition}','${member}','participant',now());
      insert into public.group_invites(group_id,created_by) values ('${group}','${member}');
      insert into public.group_email_invites(group_id,email,invited_by) values
        ('${group}','member@example.com','${admin}'),('${group}','pending@example.com','${member}');
      insert into public.competition_start_email_outbox(competition_id,user_id,started_by,email,competition_name,group_name)
        values ('${competition}','${member}','${admin}','member@example.com','Shared competition','Shared group');
      insert into public.web_push_subscriptions(user_id,endpoint,p256dh,auth,locale)
        values ('${member}','https://web.push.apple.com/member-device',
          '${Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url")}',
          '${Buffer.alloc(16, 1).toString("base64url")}','en');
      insert into public.competition_push_events(competition_id,phase) values ('${competition}','submission');
      insert into public.competition_push_outbox(event_id,subscription_id)
        select event.id, subscription.id from public.competition_push_events event
          cross join public.web_push_subscriptions subscription;
      insert into storage.objects(bucket_id,name,owner_id) values
        ('competition-submissions','${competition}/${entry}/photo.jpg','${member}'),
        ('competition-submissions','unlinked/photo.jpg','${member}'),
        ('competition-submissions','${competition}/${otherEntry}/retained.jpg','${outsider}');
    `);
    await actor(member);
    await db.query("select public.record_my_activity()");
    await expect(db.query("select * from public.get_platform_users()")).rejects.toThrow("Platform administrator");
    await expect(db.query("select * from public.user_activity")).rejects.toThrow();
    await expect(db.query("select public.prepare_account_deletion($1)", [outsider])).rejects.toThrow("Account deletion access");
    await expect(db.query("select public.delete_account($1)", [outsider])).rejects.toThrow("Account deletion access");
    await actor(admin);
    const users = (await db.query<{ id: string; groups: unknown[]; last_active_at: string | null }>("select * from public.get_platform_users()")).rows;
    expect(users).toHaveLength(3);
    expect(users.find((user) => user.id === member)?.groups).toEqual([{ id: group, name: "Shared group", role: "admin" }]);
    expect(users.find((user) => user.id === member)?.last_active_at).toBeTruthy();
    expect(users.find((user) => user.id === outsider)?.last_active_at).toBeNull();
    expect((await db.query("select * from public.get_platform_users(100)")).rows).toEqual([]);
    await expect(db.query("select * from public.get_platform_users(-1)")).rejects.toThrow("Invalid offset");
    await actor(member, "anon");
    await expect(db.query("select public.delete_account($1)", [member])).rejects.toThrow();
    await actor(member);
    expect((await db.query("select * from public.prepare_account_deletion($1)", [member])).rows).toHaveLength(2);
    expect((await db.query("select public.account_allows_upload() allowed")).rows[0]).toEqual({ allowed: false });
    await expect(db.query("select public.delete_account($1)", [member])).rejects.toThrow("media cleanup required");
    await db.exec("reset role");
    await db.exec(`delete from storage.objects where owner_id = '${member}'`);
    await actor(member);
    await db.query("select public.delete_account($1)", [member]);
    await expect(db.query("select public.record_my_activity()")).rejects.toThrow("Authentication required");
    await expect(db.query("select public.delete_account($1)", [outsider])).rejects.toThrow("Account deletion access");
    await db.exec("reset role");
    for (const table of ["votes", "entry_disqualification_events", "published_competition_results",
      "competition_participants", "group_invites", "group_email_invites", "user_activity",
      "account_deletion_requests", "competition_start_email_outbox", "web_push_subscriptions", "competition_push_outbox"]) {
      expect((await db.query(`select count(*)::int n from public.${table}`)).rows[0]).toEqual({ n: 0 });
    }
    expect((await db.query("select created_by from public.groups")).rows[0]).toEqual({ created_by: null });
    expect((await db.query("select count(*)::int n from public.competitions")).rows[0]).toEqual({ n: 1 });
    expect((await db.query("select id from public.entries")).rows).toEqual([{ id: otherEntry }]);
    expect((await db.query("select count(*)::int n from storage.objects")).rows[0]).toEqual({ n: 1 });
    await actor(admin);
    await db.query("select public.prepare_account_deletion($1)", [outsider]);
    await db.exec("reset role");
    await db.exec(`delete from storage.objects where owner_id = '${outsider}'`);
    await actor(admin);
    await db.query("select public.delete_account($1)", [outsider]);
    await db.query("select public.delete_account($1)", [admin]);
    await expect(db.query("select * from public.get_platform_users()")).rejects.toThrow("Platform administrator");
    await db.exec("reset role");
    expect((await db.query("select count(*)::int n from auth.users")).rows[0]).toEqual({ n: 0 });
    expect((await db.query("select count(*)::int n from public.platform_admins")).rows[0]).toEqual({ n: 0 });
  } finally {
    await db.close();
  }
});
