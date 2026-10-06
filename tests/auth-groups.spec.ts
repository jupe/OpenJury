import { expect, test, type Page } from "@playwright/test";

const supabaseURL = "https://foundation.supabase.co";
const groupId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function session(user = userId, email = "member@example.com") {
  return {
    access_token: `test-token-${user}`,
    refresh_token: "test-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: user, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  };
}

async function configure(page: Page, signedIn = false, passwordSignIn = false) {
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.__OPENJURY_CONFIG__ = ${JSON.stringify({ SUPABASE_URL: supabaseURL, SUPABASE_ANON_KEY: "public-test-anon", PASSWORD_SIGN_IN: passwordSignIn })};`,
  }));
  await page.route(`${supabaseURL}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (path === "/auth/v1/otp") return route.fulfill({ json: {} });
    if (path === "/auth/v1/token") return route.fulfill({ json: session(userId, "admin@openjury.test") });
    if (path === "/auth/v1/user") return route.fulfill({ json: session().user });
    if (path === "/rest/v1/groups") {
      const id = new URL(route.request().url()).searchParams.get("id");
      return route.fulfill({ json: id === `eq.${secondId}` ? [] : [{ id: groupId, name: "Baking club" }] });
    }
    if (path === "/rest/v1/group_members") return route.fulfill({ json: [{ role: "admin" }] });
    if (path === "/rest/v1/competitions") return route.fulfill({ json: [] });
    if (path === "/rest/v1/categories") return route.fulfill({ json: [] });
    if (path === "/rest/v1/rpc/get_admin_competition_attendees") return route.fulfill({
      json: [{
        user_id: userId,
        display_name: "Alex Baker",
        role: "admin",
        has_submission: true,
        has_voted: false,
      }],
    });
    return route.fulfill({ status: 400, json: { message: `Unexpected endpoint: ${path}` } });
  });
  if (signedIn) {
    await page.addInitScript((value) => {
      localStorage.setItem("sb-foundation-auth-token", JSON.stringify(value));
    }, session());
  }
}

async function expectPhoneLayout(page: Page) {
  const layout = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= window.innerWidth,
    width: window.innerWidth,
    controls: Array.from(document.querySelectorAll("input, select, button, main a, nav a, summary"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          height: box.height,
          width: box.width,
          x: box.x,
          visible: style.visibility !== "hidden" && box.width > 0 && box.height > 0,
          input: element.matches("input, select"),
          fontSize: parseFloat(style.fontSize),
        };
      }),
  }));
  expect(layout.fits).toBe(true);
  for (const control of layout.controls.filter((control) => control.visible)) {
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(layout.width);
    if (control.input) expect(control.fontSize).toBeGreaterThanOrEqual(16);
  }
}

test("small phone forms, long names and landscape stay usable @mobile", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => route.fulfill({
    json: [{ id: groupId, name: "Community".repeat(12) }],
  }));
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: secondId,
      name: "Competition".repeat(9),
      event_type: "remote",
      status: "draft",
      submission_deadline: null,
      voting_deadline: null,
    }],
  }));
  for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "New group" }).click();
    await expect(page.getByRole("textbox", { name: "Group name" })).toBeVisible();
    await expectPhoneLayout(page);
    await page.goto(`/group/${groupId}`);
    await expect(page.getByRole("textbox", { name: "Competition name" })).toBeVisible();
    await page.getByRole("textbox", { name: "Competition name" }).fill("Phone bake-off");
    await page.getByLabel("Submission deadline").fill("2026-11-01T12:00");
    await page.getByLabel("Voting deadline").fill("2026-11-02T12:00");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByRole("textbox", { name: "Category name" })).toHaveCount(2);
    await expectPhoneLayout(page);
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    await expect(page.getByRole("textbox", { name: "Category name" })).toHaveCount(1);
  }
});

test("group admins can rename and remove groups", async ({ page }) => {
  await configure(page, true);
  const renames: unknown[] = [];
  const removals: unknown[] = [];
  await page.route(`${supabaseURL}/rest/v1/rpc/rename_group`, async (route) => {
    renames.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.route(`${supabaseURL}/rest/v1/rpc/delete_group`, async (route) => {
    removals.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });

  await page.goto(`/group/${groupId}`);
  const groupName = page.getByRole("textbox", { name: "Group name" });
  await expect(groupName).toHaveValue("Baking club");
  await groupName.fill("New baking club");
  await page.getByRole("button", { name: "Rename group" }).click();
  await expect(page.getByRole("status")).toContainText("Group name updated.");
  expect(renames).toEqual([{ p_group_id: groupId, p_name: "New baking club" }]);

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove group" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(removals).toEqual([{ p_group_id: groupId }]);
});

test("ordinary group members cannot manage group settings", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({
    json: [{ role: "member" }],
  }));

  await page.goto(`/group/${groupId}`);
  await expect(page.getByRole("heading", { name: "Group settings" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove group" })).toHaveCount(0);
});

test("phone sign-in controls support zoom and comfortable touch targets @mobile", async ({ page }) => {
  await configure(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  await expectPhoneLayout(page);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1/);
});

test("phone image upload, uncropped preview and removal work @mobile", async ({ page }) => {
  await configure(page, true);
  await page.setViewportSize({ width: 320, height: 568 });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const saves: Array<{ p_title: string; p_media_keys: string[] }> = [];
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: secondId, group_id: groupId, name: "Phone photos", status: "submission", submission_deadline: null, voting_deadline: null, competition_participants: [{ role: "participant" }] }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/save_submission`, (route) => {
    saves.push(route.request().postDataJSON());
    return route.fulfill({ json: groupId });
  });
  await page.route(`${supabaseURL}/storage/v1/object/**`, (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { Key: "uploaded.png" } });
    if (route.request().method() === "DELETE") return route.fulfill({ json: [] });
    return route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto(`/competition/${secondId}`);
  await page.getByRole("textbox", { name: "Entry title" }).fill("My phone photo");
  await page.getByLabel("Images (JPEG").setInputFiles({ name: "phone.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("1 new image(s) selected.")).toBeVisible();
  await expectPhoneLayout(page);
  await page.getByRole("button", { name: "Save submission" }).click();
  await expect(page.getByRole("heading", { name: "Edit your submission" })).toBeVisible();
  expect(saves[1].p_title).toBe("My phone photo");
  expect(saves[1].p_media_keys).toHaveLength(1);
  const preview = page.getByRole("img", { name: "Your submission image 1", exact: true });
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  await preview.click();
  await expect(page.getByRole("dialog", { name: "Your submission image gallery" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Your submission image 1, full view" })).toBeVisible();
  await expectPhoneLayout(page);
  await page.getByRole("button", { name: "Close gallery" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Remove image 1" }).click();
  await page.getByRole("button", { name: "Save submission" }).click();
  await expect.poll(() => saves.at(-1)?.p_media_keys).toEqual([]);
});

test("off-screen private voting media is deferred until scrolling @mobile", async ({ page }) => {
  await configure(page, true);
  await page.setViewportSize({ width: 320, height: 568 });
  const downloads: string[] = [];
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: secondId, group_id: groupId, name: "Photo jury", status: "voting", submission_deadline: null, voting_deadline: null, competition_participants: [{ role: "audience" }] }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_ballot`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/categories**`, (route) => route.fulfill({
    json: Array.from({ length: 10 }, (_, index) => ({ id: `category-${index}`, name: `Criterion ${index}`, max_score: 5 })),
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_blind_voting_entries`, (route) => route.fulfill({
    json: [{ entry_number: 1, media_keys: ["first.png"] }, { entry_number: 2, media_keys: ["second.png"] }],
  }));
  await page.route(`${supabaseURL}/storage/v1/object/**`, (route) => {
    downloads.push(route.request().url().split("/").at(-1)!);
    return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
  });
  await page.goto(`/competition/${secondId}`);
  await page.getByRole("heading", { name: "Entry 1", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("img", { name: "Anonymous entry 1 image 1", exact: true })).toBeVisible();
  expect(downloads).toEqual(["first.png"]);
  await page.getByRole("heading", { name: "Entry 2", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("img", { name: "Anonymous entry 2 image 1", exact: true })).toBeVisible();
  expect(downloads).toEqual(["first.png", "second.png"]);
  await expectPhoneLayout(page);
});

async function mockRealtime(page: Page) {
  const channels = new Map<string, { socket: import("@playwright/test").WebSocketRoute; joinRef: string }>();
  await page.routeWebSocket("wss://foundation.supabase.co/realtime/v1/websocket**", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const [joinRef, ref, topic, event] = JSON.parse(message) as [string, string, string, string];
      if (event === "phx_join") {
        channels.set(topic, { socket, joinRef });
        socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
      } else if (event === "heartbeat") {
        socket.send(JSON.stringify([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]));
      }
    });
  });
  return {
    hasChannel: (topic: string) => channels.has(`realtime:${topic}`),
    broadcast(topic: string, event: string) {
      const channel = channels.get(`realtime:${topic}`);
      if (!channel) throw new Error(`Realtime channel not joined: ${topic}`);
      channel.socket.send(JSON.stringify([
        channel.joinRef,
        null,
        `realtime:${topic}`,
        "broadcast",
        { event, payload: { version: 1 } },
      ]));
    },
  };
}

test("unconfigured deployments run the in-browser demo without network data", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'window.__OPENJURY_CONFIG__ = {SUPABASE_URL: "", SUPABASE_ANON_KEY: ""};',
  }));
  const apiRequests: string[] = [];
  page.on("request", (request) => { if (/\/(rest|auth|storage)\/v1\//.test(request.url())) apiRequests.push(request.url()); });
  for (const path of ["/", "/dashboard"]) {
    await page.goto(path);
    await expect(page.getByRole("complementary", { name: "Demo mode" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Account (alex@demo.openjury.app)" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Send sign-in link" })).toHaveCount(0);
  }
  await expect(page.getByRole("link", { name: "Northside Makers" })).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("configured signed-out routes prompt login without group queries", async ({ page }) => {
  await configure(page);
  const groupRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/rest/v1/")) groupRequests.push(request.url()); });
  for (const path of ["/", "/dashboard", `/group/${groupId}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create group", exact: true })).toHaveCount(0);
  }
  expect(groupRequests).toEqual([]);
});

test("magic link permits signup and redirects to dashboard with accessible status", async ({ page }) => {
  await configure(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "Email address" }).fill("new@example.com");
  const requestPromise = page.waitForRequest((request) => request.url().includes("/auth/v1/otp"));
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toMatchObject({ email: "new@example.com", create_user: true });
  expect(new URL(request.url()).searchParams.get("redirect_to")).toBe(new URL("/dashboard", page.url()).href);
  await expect(page.getByRole("status")).toContainText("Check your email");
});

test("password sign-in is hidden unless enabled", async ({ page }) => {
  await configure(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
});

test("preview password sign-in uses the seeded account", async ({ page }) => {
  await configure(page, false, true);
  await page.goto("/");
  const form = page.locator("form").filter({ has: page.getByLabel("Password") });
  await form.getByRole("textbox", { name: "Email address" }).fill("admin@openjury.test");
  await form.getByLabel("Password").fill("preview-secret");
  const requestPromise = page.waitForRequest((request) => request.url().includes("/auth/v1/token"));
  await page.getByRole("button", { name: "Sign in with password" }).click();
  const request = await requestPromise;
  expect(new URL(request.url()).searchParams.get("grant_type")).toBe("password");
  expect(request.postDataJSON()).toMatchObject({ email: "admin@openjury.test", password: "preview-secret" });
  await expect(page.getByRole("button", { name: "Account (admin@openjury.test)" })).toBeVisible();
});

test("OTP failures and rejected links are visible and retryable", async ({ page }) => {
  await configure(page);
  await page.route(`${supabaseURL}/auth/v1/otp**`, (route) => route.fulfill({
    status: 429, json: { msg: "Too many requests" },
  }));
  await page.goto("/dashboard#error=access_denied&error_description=Link%20expired");
  await expect(page.getByRole("alert").filter({ hasText: "Link expired" })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("textbox", { name: "Email address" }).fill("member@example.com");
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Unable to send" })).toContainText("Too many requests");
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeEnabled();
});

test("session initialization errors fail closed and offer retry", async ({ page }) => {
  await configure(page);
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "sb-foundation-auth-token") throw new Error("Session storage unavailable");
      return getItem.call(this, key);
    };
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("alert").filter({ hasText: "Unable to load your session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry session" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Group name" })).toHaveCount(0);
});

test("implicit magic link establishes a browser session", async ({ page }) => {
  await configure(page);
  await page.goto(`/dashboard#access_token=magic-link-token&refresh_token=test-refresh&expires_in=3600&token_type=bearer`);
  await expect(page.getByRole("button", { name: "Account (member@example.com)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard#?$/);
});

test("signed-in dashboard lists RLS groups and creates a group via RPC", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/rpc/create_group`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ group_name: "New community" });
    return route.fulfill({ json: secondId });
  });

  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    return route.fulfill({ json: [{ id: id ? secondId : groupId, name: id ? "New community" : "Baking club" }] });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toHaveAttribute("href", `/group/${groupId}`);
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("  New community  ");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/group/${secondId}$`));
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("New community")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Competitions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a draft competition" })).toBeVisible();
});

test("group admins create and edit draft competitions with scoring criteria", async ({ page }) => {
  await configure(page, true);
  const competitionId = "33333333-3333-4333-8333-333333333333";
  const competitions: Array<Record<string, unknown>> = [];
  const saves: Array<Record<string, unknown>> = [];
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({ json: competitions }));
  await page.route(`${supabaseURL}/rest/v1/categories**`, (route) => route.fulfill({
    json: [{ name: "Taste", max_score: 5 }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/save_draft_competition`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    saves.push(body);
    const categories = body.p_categories as Array<{ name: string; max_score: number }>;
    if (!body.p_competition_id) {
      competitions.splice(0, competitions.length, {
        id: competitionId,
        name: body.p_name,
        description: body.p_description,
        rules: body.p_rules,
        event_type: body.p_event_type,
        status: "draft",
        submission_deadline: body.p_submission_deadline,
        voting_deadline: body.p_voting_deadline,
      });
    } else {
      Object.assign(competitions[0], { name: body.p_name, description: body.p_description, rules: body.p_rules });
    }
    expect(categories).toHaveLength(1);
    return route.fulfill({ json: competitionId });
  });

  await page.goto(`/group/${groupId}`);
  await page.getByRole("textbox", { name: "Competition name" }).fill("Autumn bake-off");
  await page.getByLabel("Description (optional)").fill("  A friendly baking competition.  ");
  await page.getByLabel("Rules (optional)").fill("One entry per person.\nNo identifying marks.");
  await page.getByRole("textbox", { name: "Category name" }).fill("Taste");
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect(page.getByRole("link", { name: "Autumn bake-off", exact: true })).toHaveAttribute("href", `/competition/${competitionId}`);
  expect(saves[0]).toMatchObject({
    p_competition_id: null,
    p_group_id: groupId,
    p_name: "Autumn bake-off",
    p_description: "A friendly baking competition.",
    p_rules: "One entry per person.\nNo identifying marks.",
    p_event_type: "remote",
    p_categories: [{ name: "Taste", max_score: 5 }],
  });

  await page.getByRole("button", { name: "Edit draft" }).click();
  await expect(page.getByLabel("Description (optional)")).toHaveValue("A friendly baking competition.");
  await expect(page.getByLabel("Rules (optional)")).toHaveValue("One entry per person.\nNo identifying marks.");
  await page.getByLabel("Description (optional)").fill("");
  await page.getByLabel("Rules (optional)").fill("");
  await expect(page.getByRole("textbox", { name: "Category name" })).toHaveValue("Taste");
  await page.getByRole("textbox", { name: "Category name" }).fill("Creativity");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({
    p_competition_id: competitionId,
    p_group_id: groupId,
    p_description: null,
    p_rules: null,
    p_categories: [{ name: "Creativity", max_score: 5 }],
  });
});

test("admins edit competition details after opening; members read plain text details @mobile", async ({ page }) => {
  await configure(page, true);
  const competitionId = "33333333-3333-4333-8333-333333333333";
  const competition = {
    id: competitionId, group_id: groupId, name: "Autumn bake-off",
    description: "Original description" as string | null, rules: null as string | null,
    status: "submission", submission_deadline: null, voting_deadline: null,
    groups: { name: "Baking club" },
  };
  const saves: Array<Record<string, unknown>> = [];
  let failSave = true;
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({ json: [competition] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/save_competition_details`, (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    if (failSave) return route.fulfill({ status: 400, json: { message: "Please try again" } });
    Object.assign(competition, { name: body.p_name, description: body.p_description, rules: body.p_rules });
    return route.fulfill({ json: null });
  });
  await page.goto(`/competition/${competitionId}/admin`);
  await page.getByRole("button", { name: "Edit competition details" }).click();
  await expect(page.getByLabel("Competition name")).toHaveValue("Autumn bake-off");
  await expect(page.getByLabel("Description (optional)")).toHaveValue("Original description");
  await expect(page.getByLabel("Rules (optional)")).toHaveValue("");
  await expect(page.getByLabel("Description (optional)")).toHaveAttribute("maxlength", "10000");
  await expect(page.getByLabel("Rules (optional)")).toHaveAttribute("maxlength", "10000");
  await page.getByLabel("Competition name").fill("Cancelled change");
  await page.getByRole("button", { name: "Cancel edit" }).click();
  expect(saves).toHaveLength(0);
  await page.getByRole("button", { name: "Edit competition details" }).click();
  await expect(page.getByLabel("Competition name")).toHaveValue("Autumn bake-off");
  await page.getByLabel("Competition name").fill("  Winter bake-off  ");
  await page.getByLabel("Description (optional)").fill("  Share your best bakes.\nEveryone is welcome.  ");
  await page.getByLabel("Rules (optional)").fill("<b>No identifying marks.</b>\nOne entry per person.");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Unable to save competition details: Please try again");
  await expect(page.getByLabel("Competition name")).toHaveValue("  Winter bake-off  ");
  failSave = false;
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status")).toHaveText("Competition details saved.");
  await expect(page.getByRole("heading", { name: "Winter bake-off", exact: true })).toBeVisible();
  expect(saves[1]).toEqual({
    p_competition_id: competitionId,
    p_name: "Winter bake-off",
    p_description: "Share your best bakes.\nEveryone is welcome.",
    p_rules: "<b>No identifying marks.</b>\nOne entry per person.",
  });
  await expect(page.getByText("Status: Open for entries")).toBeVisible();
  await expectPhoneLayout(page);

  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({ json: [{ role: "member" }] }));
  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByRole("heading", { name: "Description", exact: true })).toBeVisible();
  await expect(page.getByText("Share your best bakes. Everyone is welcome.")).toBeVisible();
  await expect(page.getByText("<b>No identifying marks.</b> One entry per person.")).toBeVisible();
  await expect(page.locator("main b")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit competition details" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage competition" })).toHaveCount(0);

  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({ json: [{ role: "admin" }] }));
  await page.goto(`/competition/${competitionId}/admin`);
  await page.getByRole("button", { name: "Edit competition details" }).click();
  await page.getByLabel("Description (optional)").fill("  ");
  await page.getByLabel("Rules (optional)").fill("");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status")).toHaveText("Competition details saved.");
  expect(saves[2]).toMatchObject({ p_description: null, p_rules: null });
  await expect(page.getByRole("heading", { name: "Description", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Rules", exact: true })).toHaveCount(0);

  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) =>
    route.fulfill({ status: 403, json: { code: "42501", message: "Admin access required" } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit competition details" })).toHaveCount(0);
});

test("ordinary group members can view competitions but cannot create drafts", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({
    json: [{ role: "member" }],
  }));
  await page.goto(`/group/${groupId}`);
  await expect(page.getByRole("heading", { name: "Competitions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a draft competition" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit draft" })).toHaveCount(0);
});

test("participants refetch authorized competition data after reconnect", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  const tasteId = "44444444-4444-4444-8444-444444444444";
  let status = "submission";
  const realtime = await mockRealtime(page);
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId,
      group_id: groupId,
      name: "Reconnect bake-off",
      status,
      submission_deadline: null,
      voting_deadline: null,
      competition_participants: [{ role: "audience" }],
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/categories**`, (route) =>
    route.fulfill({ json: [{ id: tasteId, name: "Taste", max_score: 5 }] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_blind_voting_entries`, (route) =>
    route.fulfill({ json: [{ entry_number: 7, media_keys: [] }] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_ballot`, (route) =>
    route.fulfill({ json: [] }));

  await page.goto(`/competition/${competitionId}`);
  await expect.poll(() => realtime.hasChannel(`group:${groupId}`)).toBe(true);
  await expect(page.getByText("Status: Open for entries")).toBeVisible();
  status = "voting";
  const refetch = page.waitForRequest((request) =>
    request.url().includes("/rest/v1/competitions"));
  realtime.broadcast(`group:${groupId}`, "data_changed");
  await refetch;
  await expect(page.getByRole("heading", { name: "Entry 7" })).toBeVisible();
  await expect(page.getByText("Status: Voting")).toBeVisible();

  status = "review_pending";
  const waitingRefetch = page.waitForRequest((request) =>
    request.url().includes("/rest/v1/competitions"));
  realtime.broadcast(`group:${groupId}`, "data_changed");
  await waitingRefetch;
  await expect(page.getByRole("heading", { name: "Voting ended" })).toBeVisible();
  await expect(page.getByText(/The administrator is reviewing the results/)).toBeVisible();

  status = "results_published";
  await page.route(`${supabaseURL}/rest/v1/rpc/get_published_competition_results`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_published_competition_category_results`, (route) =>
    route.fulfill({ json: [] }));
  const reconnect = page.waitForRequest((request) =>
    request.url().includes("/rest/v1/competitions"));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await reconnect;
  await expect(page.getByRole("heading", { name: "Published results" })).toBeVisible();
});

test("admins discard private review data after membership is revoked", async ({ page }) => {
  const competitionId = "66666666-6666-4666-8666-666666666666";
  let accessible = true;
  const realtime = await mockRealtime(page);
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: accessible ? [{
      id: competitionId,
      group_id: groupId,
      name: "Revoked review",
      status: "review_pending",
      submission_deadline: null,
      voting_deadline: null,
    }] : [],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) => route.fulfill({
    json: accessible ? [{
      id: "77777777-7777-4777-8777-777777777777",
      creator_id: userId,
      title: "Private admin entry",
      media_keys: [],
    }] : [],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_review_results`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_review_category_results`, (route) =>
    route.fulfill({ json: [] }));

  await page.goto(`/competition/${competitionId}/admin`);
  await expect.poll(() => realtime.hasChannel(`user:${userId}`)).toBe(true);
  await expect(page.getByText("Private admin entry")).toBeVisible();
  await expect(page.getByText("Alex Baker", { exact: true })).toBeVisible();
  accessible = false;
  const refetch = page.waitForRequest((request) =>
    request.url().includes("/rest/v1/competitions"));
  realtime.broadcast(`user:${userId}`, "membership_changed");
  await refetch;
  await expect(page.getByText(/Unable to load competition status/)).toBeVisible();
  await expect(page.getByText("Private admin entry")).toHaveCount(0);
  await expect(page.getByText("Alex Baker", { exact: true })).toHaveCount(0);
});

test("empty memberships and failed group creation provide clear feedback", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/create_group`, (route) => route.fulfill({
    status: 400, json: { message: "Group name rejected" },
  }));
  await page.goto("/dashboard");
  await expect(page.getByText("You do not belong to any groups yet. Open an invite link from a group admin, or create a group with +.")).toBeVisible();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("New group");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Group name rejected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toBeEnabled();
});

test("missing, inaccessible and invalid group IDs do not expose competitions", async ({ page }) => {
  await configure(page, true);
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/rest\/v1\/(competitions|entries|votes)/.test(request.url())) privateRequests.push(request.url());
  });
  for (const id of [secondId, "invalid-id"]) {
    await page.goto(`/group/${id}`);
    await expect(page.getByRole("heading", { name: "Group not found or access denied" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview a competition" })).toHaveCount(0);
  }
  expect(privateRequests).toEqual([]);
});

test("group list and detail query errors can be retried", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => route.fulfill({
    status: 400, json: { message: "Database unavailable" },
  }));
  await page.goto("/dashboard");
  await expect(page.getByRole("alert").filter({ hasText: "Unable to load groups" })).toBeVisible();
  await page.goto(`/group/${groupId}`);
  await expect(page.getByRole("alert").filter({ hasText: "Unable to load group" })).toBeVisible();
  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => route.fulfill({ json: [{ id: groupId, name: "Recovered group" }] }));
  await page.getByRole("button", { name: "Retry group" }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Recovered group")).toBeVisible();
});

test("logout reports server failure even when Supabase clears the local session", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/auth/v1/logout**`, (route) => route.fulfill({
    status: 500, json: { msg: "Logout unavailable" },
  }));
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Unable to complete sign out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Baking club" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("sb-foundation-auth-token"))).toBeNull();
});

test("logout succeeds and clears browser session and private groups", async ({ page }) => {
  await configure(page, true);
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Baking club" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("sb-foundation-auth-token"))).toBeNull();
});

test("expired sessions remove private views on sign out", async ({ page }) => {
  await configure(page, true);
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
  await page.evaluate(() => {
    const channel = new BroadcastChannel("sb-foundation-auth-token");
    channel.postMessage({ event: "SIGNED_OUT", session: null });
    channel.close();
  });
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Baking club" })).toHaveCount(0);
});

test("auth changes discard in-flight data from the previous user", async ({ page }) => {
  await configure(page, true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(`${supabaseURL}/rest/v1/groups**`, async (route) => {
    if (route.request().headers().authorization?.includes(userId)) {
      requested();
      await pending;
      await route.fulfill({ json: [{ id: groupId, name: "Old user's private group" }] });
    } else await route.fulfill({ json: [] });
  });
  await page.goto("/dashboard");
  await started;
  await expect(page.getByRole("status")).toHaveText("Loading groups…");
  await page.evaluate((nextSession) => {
    localStorage.setItem("sb-foundation-auth-token", JSON.stringify(nextSession));
    const channel = new BroadcastChannel("sb-foundation-auth-token");
    channel.postMessage({ event: "SIGNED_IN", session: nextSession });
    channel.close();
  }, session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "other@example.com"));
  await expect(page.getByRole("button", { name: "Account (other@example.com)" })).toBeVisible();
  release();
  await expect(page.getByText("You do not belong to any groups yet. Open an invite link from a group admin, or create a group with +.")).toBeVisible();
  await expect(page.getByText("Old user's private group")).toHaveCount(0);
});

test("voting cards load a private ballot and save score revisions", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  const tasteId = "44444444-4444-4444-8444-444444444444";
  const presentationId = "55555555-5555-4555-8555-555555555555";
  let savedBallot: unknown;
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId,
      name: "Blind bake-off",
      status: "voting",
      submission_deadline: null,
      voting_deadline: new Date(Date.now() + 60_000).toISOString(),
      competition_participants: [{ role: "audience" }],
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/categories**`, (route) => route.fulfill({
    json: [
      { id: tasteId, name: "Taste", max_score: 5 },
      { id: presentationId, name: "Presentation", max_score: 3 },
    ],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_blind_voting_entries`, (route) =>
    route.fulfill({ json: [{ entry_number: 7, media_keys: [] }] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_ballot`, (route) =>
    route.fulfill({ json: [
      { entry_number: 7, category_id: tasteId, score: 2 },
      { entry_number: 7, category_id: presentationId, score: 3 },
    ] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/save_ballot`, async (route) => {
    savedBallot = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });

  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByRole("heading", { name: "Entry 7" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Taste" })).toHaveValue("2");
  await expect(page.getByRole("slider", { name: "Presentation" })).toHaveValue("3");
  await expect(page.getByText("Voted", { exact: true })).toBeVisible();
  await expectPhoneLayout(page);
  await page.getByRole("slider", { name: "Taste" }).fill("4");
  await expect(page.getByRole("status")).toContainText("Vote recorded · Entry 7");
  expect(savedBallot).toEqual({
    p_competition_id: competitionId,
    p_entry_number: 7,
    p_scores: [
      { category_id: tasteId, score: 4 },
      { category_id: presentationId, score: 3 },
    ],
  });
  await page.screenshot({ path: "/tmp/openjury-voting-ballot.png", fullPage: true });
});

test("admins disqualify and publish while group members see only final identities", async ({ page }) => {
  const competitionId = "66666666-6666-4666-8666-666666666666";
  let status = "review_pending";
  let reviewRows: Array<Record<string, unknown>> = [{
    entry_id: "77777777-7777-4777-8777-777777777777",
    creator_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Reviewed entry",
    is_disqualified: false,
    rank: 1,
    score: 82.5,
    vote_count: 2,
    disqualification_reason: null,
    disqualified_by: null,
    disqualified_at: null,
    disqualification_display: "exclude",
    content_removed: false,
  }];
  let disqualification: Record<string, unknown> | undefined;
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: competitionId, name: "Finals", status, submission_deadline: null, voting_deadline: null }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) =>
    route.fulfill({ json: [{
      id: reviewRows[0].entry_id,
      creator_id: reviewRows[0].creator_id,
      title: reviewRows[0].title,
      media_keys: [],
    }] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_review_results`, (route) =>
    route.fulfill({ json: reviewRows }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_review_category_results`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/disqualify_competition_entry`, async (route) => {
    const nextDisqualification = route.request().postDataJSON() as Record<string, unknown>;
    disqualification = nextDisqualification;
    reviewRows = reviewRows.map((entry) => ({
      ...entry,
      is_disqualified: true,
      rank: null,
      score: null,
      vote_count: 0,
      disqualification_reason: nextDisqualification.p_reason,
      disqualification_display: nextDisqualification.p_disposition,
      disqualified_by: userId,
      disqualified_at: "2026-10-04T11:00:00.000Z",
    }));
    await route.fulfill({ status: 204 });
  });
  await page.route(`${supabaseURL}/rest/v1/rpc/publish_competition_results`, async (route) => {
    status = "results_published";
    await route.fulfill({ status: 204 });
  });
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_published_competition_results`, (route) =>
    route.fulfill({ json: [{
      rank: 1,
      score: 82.5,
      vote_count: 2,
      title: "Reviewed entry",
      creator_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      creator_name: "Alex Baker",
      is_disqualified: false,
    }] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_published_competition_category_results`, (route) =>
    route.fulfill({ json: [] }));

  await page.goto(`/competition/${competitionId}/admin`);
  await expect(page.getByRole("heading", { name: "Preliminary rankings (admins only)" })).toBeVisible();
  await expectPhoneLayout(page);
  await page.getByLabel("Disqualification reason").fill("Rule violation");
  await page.getByRole("button", { name: "Disqualify" }).click();
  await expect(page.getByText("Disqualified (exclude): Rule violation")).toBeVisible();
  await expect(page.getByText(/Admin Alex Baker/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(userId);
  expect(disqualification).toMatchObject({
    p_competition_id: competitionId,
    p_entry_id: "77777777-7777-4777-8777-777777777777",
    p_reason: "Rule violation",
  });
  await page.getByRole("button", { name: "Publish final results" }).click();
  await expect(page.getByRole("status")).toContainText("Results published");

  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByRole("heading", { name: "Published results" })).toBeVisible();
  await expect(page.getByText("Submitted by Alex Baker")).toBeVisible();
  await expect(page.getByText("83% · 2 complete ballots")).toBeVisible();
  await expectPhoneLayout(page);
});

test("competition admins see all attendees, including non-submitters and former members", async ({ page }) => {
  await configure(page, true);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: secondId, group_id: groupId, name: "Community bake-off", status: "submission" }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) => route.fulfill({
    json: [{ id: groupId, creator_id: userId, title: "Lemon tart", media_keys: [] }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_competition_attendees`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ p_competition_id: secondId });
    return route.fulfill({
      json: [
        { user_id: userId, display_name: "Alex Baker", role: "admin", has_submission: true, has_voted: false },
        { user_id: secondId, display_name: "Voter only", role: "member", has_submission: false, has_voted: true },
        { user_id: groupId, display_name: "Not started", role: "member", has_submission: false, has_voted: false },
        { user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "Former entrant", role: "former member", has_submission: true, has_voted: false },
      ],
    });
  });
  await page.route(`${supabaseURL}/rest/v1/rpc/get_competition_participants`, (route) => route.fulfill({
    json: [
      { user_id: userId, email: "alex@example.com", role: "participant", has_entry: true },
      { user_id: secondId, email: "voter@example.com", role: "audience", has_entry: false },
    ],
  }));
  await page.goto(`/competition/${secondId}/admin`);
  await expect(page.getByRole("heading", { name: "Community bake-off" })).toBeVisible();
  const roster = page.getByRole("heading", { name: "Competition attendees" }).locator("..");
  await expect(roster.getByRole("listitem")).toHaveCount(4);
  await expect(roster.getByRole("listitem").filter({ hasText: "Voter only" })).toContainText("Member · Audience · No submission · Has voted");
  await expect(roster.getByRole("listitem").filter({ hasText: "Not started" })).toContainText("Member · Not taking part · No submission · Has not voted");
  await expect(roster.getByRole("listitem").filter({ hasText: "Former entrant" })).toContainText("Former member · Not taking part · Submitted");
  await expect(page.getByText("Submitted by Alex Baker")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secondId);
  await expect(page.locator("body")).not.toContainText(userId);
  await expect(page.locator("body")).not.toContainText(groupId);
  await expectPhoneLayout(page);
  await page.screenshot({ path: "/tmp/openjury-competition-attendees.png", fullPage: true });
});

test("attendee authorization errors do not expose private admin data", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: secondId, group_id: groupId, name: "Private competition", status: "submission" }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) => route.fulfill({
    json: [{ id: groupId, creator_id: userId, title: "Private entry", media_keys: [] }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_competition_attendees`, (route) => route.fulfill({
    status: 403, json: { message: "Competition administrator access required" },
  }));
  await page.goto(`/competition/${secondId}/admin`);
  await expect(page.getByRole("alert").filter({ hasText: "Unable to load competition attendees" })).toBeVisible();
  await expect(page.getByText("Private entry", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Competition attendees" })).toHaveCount(0);
});

test("group lobby shows competition status and offers admins a manage button", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId,
      name: "Autumn bake-off",
      event_type: "remote",
      status: "submission",
      submission_deadline: null,
      voting_deadline: null,
    }],
  }));

  await page.goto(`/group/${groupId}`);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
  await expect(breadcrumb.getByText("Baking club")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Open for entries")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage Autumn bake-off" }))
    .toHaveAttribute("href", `/competition/${competitionId}/admin`);
  await expectPhoneLayout(page);

  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({
    json: [{ role: "member" }],
  }));
  await page.reload();
  await expect(page.getByText("Open for entries")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage Autumn bake-off" })).toHaveCount(0);
});

test("competition pages lead back to their group and admins to management", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId,
      group_id: groupId,
      name: "Autumn bake-off",
      status: "draft",
      submission_deadline: null,
      voting_deadline: null,
      groups: { name: "Baking club" },
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) =>
    route.fulfill({ json: [] }));

  await page.goto(`/competition/${competitionId}`);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link", { name: "Baking club" })).toHaveAttribute("href", `/group/${groupId}`);
  await expect(breadcrumb.getByText("Autumn bake-off")).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Manage competition" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Autumn bake-off" }))
    .toHaveAttribute("href", `/competition/${competitionId}`);

  await page.route(`${supabaseURL}/rest/v1/group_members**`, (route) => route.fulfill({
    json: [{ role: "member" }],
  }));
  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByText("Status: Draft")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage competition" })).toHaveCount(0);
});

test("admins move a competition through its lifecycle after confirming", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  let status = "draft";
  const transitions: Array<Record<string, unknown>> = [];
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId,
      group_id: groupId,
      name: "Autumn bake-off",
      status,
      submission_deadline: null,
      voting_deadline: null,
      groups: { name: "Baking club" },
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/transition_competition`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    transitions.push(body);
    status = String(body.p_target_status);
    return route.fulfill({ json: status });
  });

  await page.goto(`/competition/${competitionId}/admin`);
  await expect(page.getByText("Status: Draft")).toBeVisible();
  await expectPhoneLayout(page);

  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Open submissions" }).click();
  expect(transitions).toEqual([]);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Open submissions" }).click();
  await expect(page.getByText("Status: Open for entries")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Close submissions and start voting" }).click();
  await expect(page.getByText("Status: Voting")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Close voting" }).click();
  await expect.poll(() => transitions.length).toBe(3);
  expect(transitions).toEqual([
    { p_competition_id: competitionId, p_target_status: "submission" },
    { p_competition_id: competitionId, p_target_status: "voting" },
    { p_competition_id: competitionId, p_target_status: "review_pending" },
  ]);
});

test("rejected lifecycle changes are reported and keep the current status", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{ id: competitionId, group_id: groupId, name: "Autumn bake-off", status: "draft", submission_deadline: null, voting_deadline: null }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_admin_submissions`, (route) =>
    route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/transition_competition`, (route) =>
    route.fulfill({ status: 400, json: { code: "55000", message: "Invalid competition status transition" } }));

  await page.goto(`/competition/${competitionId}/admin`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Open submissions" }).click();
  await expect(page.getByText("Unable to open submissions: Invalid competition status transition")).toBeVisible();
  await expect(page.getByText("Status: Draft")).toBeVisible();
});

test("members choose to take part as participant or audience before submitting", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  let role: string | null = null;
  const joins: Array<Record<string, unknown>> = [];
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId, group_id: groupId, name: "Autumn bake-off", status: "submission",
      submission_deadline: null, voting_deadline: null,
      competition_participants: role ? [{ role }] : [],
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/join_competition`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    joins.push(body);
    role = String(body.p_role);
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByRole("heading", { name: "Take part" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Entry title" })).toHaveCount(0);
  await expectPhoneLayout(page);
  await page.getByRole("button", { name: "Join as participant" }).click();
  await expect(page.getByRole("textbox", { name: "Entry title" })).toBeVisible();
  await expect(page.getByText(/taking part as a participant/)).toBeVisible();

  await page.getByRole("button", { name: "Switch to audience" }).click();
  await expect(page.getByText(/taking part as audience/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Entry title" })).toHaveCount(0);
  expect(joins).toEqual([
    { p_competition_id: competitionId, p_role: "participant" },
    { p_competition_id: competitionId, p_role: "audience" },
  ]);
});

test("participants never load the anonymous ballot, and newcomers may only join the audience during voting", async ({ page }) => {
  const competitionId = "33333333-3333-4333-8333-333333333333";
  let role: string | null = "participant";
  let ballotRequested = false;
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/competitions**`, (route) => route.fulfill({
    json: [{
      id: competitionId, group_id: groupId, name: "Autumn bake-off", status: "voting",
      submission_deadline: null, voting_deadline: null,
      competition_participants: role ? [{ role }] : [],
    }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_my_submission`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_blind_voting_entries`, (route) => {
    ballotRequested = true;
    return route.fulfill({ json: [] });
  });

  await page.goto(`/competition/${competitionId}`);
  await expect(page.getByRole("heading", { name: "Voting in progress" })).toBeVisible();
  await expect(page.getByText("Roles are fixed once voting starts.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to/ })).toHaveCount(0);
  expect(ballotRequested).toBe(false);

  role = null;
  await page.reload();
  await expect(page.getByRole("button", { name: "Join as audience" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join as participant" })).toHaveCount(0);
});

test("group admins manage members, email invites, and invite links", async ({ page }) => {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let links: Array<Record<string, unknown>> = [];
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/rpc/**`, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    if (name === "get_group_members") return route.fulfill({ json: [
      { user_id: userId, email: "member@example.com", role: "admin" },
      { user_id: otherId, email: "friend@example.com", role: "member" },
    ] });
    if (name === "get_group_email_invites") return route.fulfill({ json: [{ email: "pending@example.com", created_at: "2026-10-04T10:00:00Z" }] });
    if (name === "get_group_invite_links") return route.fulfill({ json: links });
    calls.push({ name, body });
    if (name === "create_group_invite") {
      links = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", token: "a".repeat(64), created_at: "2026-10-04T10:00:00Z" }];
      return route.fulfill({ json: "a".repeat(64) });
    }
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/group/${groupId}`);
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByText("member@example.com (you)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove group admin role from member@example.com" })).toBeDisabled();
  await page.getByRole("button", { name: "Make friend@example.com a group admin" }).click();
  await expect.poll(() => calls.at(-1)).toEqual({
    name: "set_group_member_role", body: { p_group_id: groupId, p_user_id: otherId, p_role: "admin" },
  });

  await page.getByRole("textbox", { name: "Email address" }).fill("new@example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect.poll(() => calls.at(-1)).toEqual({
    name: "invite_group_member_by_email", body: { p_group_id: groupId, p_email: "new@example.com" },
  });
  await expect(page.getByText("pending@example.com · waiting to sign in")).toBeVisible();

  await page.getByRole("button", { name: "Create invite link" }).click();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(new RegExp(`/invite/${"a".repeat(64)}$`));
  await expectPhoneLayout(page);
});

test("invite links survive sign-in and let members join the group", async ({ page }) => {
  const token = "b".repeat(64);
  let accepted = false;
  await configure(page, false);
  await page.route(`${supabaseURL}/rest/v1/rpc/get_group_invite`, (route) => route.fulfill({
    json: [{ group_id: groupId, group_name: "Baking club", is_member: accepted }],
  }));
  await page.route(`${supabaseURL}/rest/v1/rpc/accept_group_invite`, (route) => {
    accepted = true;
    return route.fulfill({ json: groupId });
  });

  await page.goto(`/invite/${token}`);
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("openjury:pending-invite"))).toBe(token);

  // The magic link returns to the dashboard, which resumes the invite.
  await page.evaluate((value) => localStorage.setItem("sb-foundation-auth-token", JSON.stringify(value)), {
    access_token: `test-token-${userId}`, refresh_token: "test-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: "member@example.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(new RegExp(`/invite/${token}$`));
  await expect(page.getByRole("heading", { name: "Join Baking club" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("openjury:pending-invite"))).toBeNull();
  await page.getByRole("button", { name: "Join group" }).click();
  await expect(page).toHaveURL(new RegExp(`/group/${groupId}$`));
});

test("revoked invite links explain what to do", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/rpc/get_group_invite`, (route) => route.fulfill({ json: [] }));
  await page.goto(`/invite/${"c".repeat(64)}`);
  await expect(page.getByText(/invalid or has been revoked/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your groups" })).toHaveAttribute("href", "/dashboard");
});

test("platform admins see every group and can take one over", async ({ page }) => {
  const otherGroup = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let joined: Record<string, unknown> | undefined;
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, (route) => route.fulfill({ json: true }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_platform_groups`, (route) => route.fulfill({ json: [
    { id: groupId, name: "Baking club", member_count: 3, admin_count: 1, my_role: "admin" },
    { id: otherGroup, name: "Chess club", member_count: 5, admin_count: 2, my_role: null },
  ] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/platform_admin_join_group`, (route) => {
    joined = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 204 });
  });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "All groups (platform admin)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Baking club" })).toHaveAttribute("href", `/group/${groupId}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Manage Chess club as admin" }).click();
  await expect(page).toHaveURL(new RegExp(`/group/${otherGroup}$`));
  expect(joined).toEqual({ p_group_id: otherGroup });
});

test("ordinary members do not see platform administration", async ({ page }) => {
  let listed = false;
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, (route) => route.fulfill({ json: false }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_platform_groups`, (route) => {
    listed = true;
    return route.fulfill({ json: [] });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All groups (platform admin)" })).toHaveCount(0);
  expect(listed).toBe(false);
});
