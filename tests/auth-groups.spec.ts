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

async function configure(page: Page, signedIn = false) {
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.__OPENJURY_CONFIG__ = ${JSON.stringify({ SUPABASE_URL: supabaseURL, SUPABASE_ANON_KEY: "public-test-anon" })};`,
  }));
  await page.route(`${supabaseURL}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (path === "/auth/v1/otp") return route.fulfill({ json: {} });
    if (path === "/auth/v1/user") return route.fulfill({ json: session().user });
    if (path === "/rest/v1/groups") {
      const id = new URL(route.request().url()).searchParams.get("id");
      return route.fulfill({ json: id === `eq.${secondId}` ? [] : [{ id: groupId, name: "Baking club" }] });
    }
    if (path === "/rest/v1/group_members") return route.fulfill({ json: [{ role: "admin" }] });
    if (path === "/rest/v1/competitions") return route.fulfill({ json: [] });
    if (path === "/rest/v1/categories") return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { message: `Unexpected endpoint: ${path}` } });
  });
  if (signedIn) {
    await page.addInitScript((value) => {
      localStorage.setItem("sb-foundation-auth-token", JSON.stringify(value));
    }, session());
  }
}

test("unconfigured pages offer setup and only public demo content", async ({ page }) => {
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'window.__OPENJURY_CONFIG__ = {SUPABASE_URL: "", SUPABASE_ANON_KEY: ""};',
  }));
  for (const path of ["/", "/dashboard", "/group/demo"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send sign-in link" })).toHaveCount(0);
  }
  await expect(page.getByRole("link", { name: "Preview a competition" })).toBeVisible();
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
  await expect(page.getByText("Signed in as member@example.com")).toBeVisible();
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
  await page.getByRole("textbox", { name: "Group name" }).fill("  New community  ");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/group/${secondId}$`));
  await expect(page.getByRole("heading", { name: "New community" })).toBeVisible();
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
        event_type: body.p_event_type,
        status: "draft",
        submission_deadline: body.p_submission_deadline,
        voting_deadline: body.p_voting_deadline,
      });
    } else {
      Object.assign(competitions[0], { name: body.p_name });
    }
    expect(categories).toHaveLength(1);
    return route.fulfill({ json: competitionId });
  });

  await page.goto(`/group/${groupId}`);
  await page.getByRole("textbox", { name: "Competition name" }).fill("Autumn bake-off");
  await page.getByRole("textbox", { name: "Category name" }).fill("Taste");
  await page.getByRole("button", { name: "Create competition" }).click();
  await expect(page.getByRole("link", { name: "Autumn bake-off" })).toHaveAttribute("href", `/competition/${competitionId}`);
  expect(saves[0]).toMatchObject({
    p_competition_id: null,
    p_group_id: groupId,
    p_name: "Autumn bake-off",
    p_event_type: "remote",
    p_categories: [{ name: "Taste", max_score: 5 }],
  });

  await page.getByRole("button", { name: "Edit draft" }).click();
  await page.getByRole("textbox", { name: "Category name" }).fill("Creativity");
  await page.getByRole("button", { name: "Save draft" }).click();
  expect(saves[1]).toMatchObject({
    p_competition_id: competitionId,
    p_group_id: groupId,
    p_categories: [{ name: "Creativity", max_score: 5 }],
  });
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

test("empty memberships and failed group creation provide clear feedback", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/rest/v1/groups**`, (route) => route.fulfill({ json: [] }));
  await page.route(`${supabaseURL}/rest/v1/rpc/create_group`, (route) => route.fulfill({
    status: 400, json: { message: "Group name rejected" },
  }));
  await page.goto("/dashboard");
  await expect(page.getByText("You do not belong to any groups yet. Create your first group below.")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Recovered group" })).toBeVisible();
});

test("logout reports server failure even when Supabase clears the local session", async ({ page }) => {
  await configure(page, true);
  await page.route(`${supabaseURL}/auth/v1/logout**`, (route) => route.fulfill({
    status: 500, json: { msg: "Logout unavailable" },
  }));
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Baking club" })).toBeVisible();
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
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Baking club" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("sb-foundation-auth-token"))).toBeNull();
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
  await expect(page.getByText("Signed in as other@example.com")).toBeVisible();
  release();
  await expect(page.getByText("You do not belong to any groups yet. Create your first group below.")).toBeVisible();
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
  await expect(page.getByLabel("Taste (1–5)")).toHaveValue("2");
  await expect(page.getByLabel("Presentation (1–3)")).toHaveValue("3");
  await expect(page.getByText(/Your own entry is excluded/)).toBeVisible();
  await page.getByLabel("Taste (1–5)").selectOption("4");
  await page.getByRole("button", { name: "Save ballot" }).click();
  await expect(page.getByRole("status")).toContainText("You can revise it until voting closes");
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
