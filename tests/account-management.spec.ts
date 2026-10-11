import { expect, test, type Page } from "@playwright/test";

const supabaseURL = "https://foundation.supabase.co";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const groupId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-01-01T12:00:00Z";

async function configure(page: Page, admin = false) {
  const session = {
    access_token: "account-management-test-token", refresh_token: "test-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: "alex@example.com", aud: "authenticated", role: "authenticated",
      app_metadata: {}, user_metadata: { display_name: "Alex Baker" }, created_at: createdAt },
  };
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.__OPENJURY_CONFIG__ = ${JSON.stringify({ SUPABASE_URL: supabaseURL, SUPABASE_ANON_KEY: "public-test-anon" })};`,
  }));
  await page.addInitScript((value) => {
    if (!localStorage.getItem("account-test-initialized")) {
      localStorage.setItem("sb-foundation-auth-token", JSON.stringify(value));
      localStorage.setItem("account-test-initialized", "true");
    }
  }, session);
  await page.route(`${supabaseURL}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (path === "/auth/v1/user") return route.fulfill({ json: session.user });
    if (path === "/rest/v1/rpc/is_platform_admin") return route.fulfill({ json: admin });
    if (path === "/rest/v1/rpc/record_my_activity") return route.fulfill({ status: 204 });
    if (path === "/rest/v1/rpc/get_platform_users") return route.fulfill({ json: [{
      id: otherId, email: "robin@example.com", display_name: "Robin Park", created_at: createdAt,
      last_active_at: "2026-10-01T12:00:00Z",
      groups: [{ id: groupId, name: "Baking club", role: "admin" }, { id: otherId, name: "Music club", role: "member" }],
    }] });
    return route.fulfill({ json: [] });
  });
}

test("profile deletion requires confirmation and cancel makes no request @mobile", async ({ page }) => {
  await configure(page);
  let deletions = 0;
  await page.route("**/api/account", (route) => { deletions++; return route.fulfill({ json: { success: true } }); });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete your account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete account permanently?" });
  await expect(dialog).toContainText("Alex Baker");
  await expect(dialog).toContainText("alex@example.com");
  await expect(dialog).toContainText("entries, media, votes, memberships, and invites");
  await expect(dialog).toContainText("platform admin can take over");
  await expect(dialog).toContainText("further submission uploads are blocked, even if cleanup fails");
  await expect(dialog).toContainText("retry to complete it");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(deletions).toBe(0);
  await page.getByRole("button", { name: "Delete your account", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(deletions).toBe(0);
});

test("profile deletion sends authenticated DELETE and clears the local session @mobile", async ({ page }) => {
  await configure(page);
  await page.route("**/api/account", (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().headers().authorization).toBe(["Bearer", "account-management-test-token"].join(" "));
    expect(route.request().postDataJSON()).toEqual({ userId });
    return route.fulfill({ json: { success: true } });
  });
  let scope = "";
  await page.route(`${supabaseURL}/auth/v1/logout**`, (route) => {
    scope = new URL(route.request().url()).searchParams.get("scope") || "";
    return route.fulfill({ status: 204 });
  });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete your account", exact: true }).click();
  await page.getByRole("button", { name: "Confirm permanent deletion" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
  expect(scope).toBe("local");
  expect(await page.evaluate(() => localStorage.getItem("sb-foundation-auth-token"))).toBeNull();
});

test("failed deletion remains retryable and pending prevents cancellation @mobile", async ({ page }) => {
  await configure(page);
  let release: (() => void) | undefined;
  await page.route("**/api/account", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: 500, json: { error: "Deletion failed" } });
  });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete your account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm permanent deletion" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!release).toBe(true);
  release!();
  await expect(dialog.getByRole("alert")).toHaveText("Unable to delete the account. Please try again.");
  await expect(dialog.getByRole("button", { name: "Confirm permanent deletion" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("platform users list shows group roles dates and refreshes after deletion @mobile", async ({ page }) => {
  await configure(page, true);
  let listRequests = 0;
  let removed = false;
  await page.route(`${supabaseURL}/rest/v1/rpc/get_platform_users`, (route) => {
    listRequests++;
    expect(route.request().postDataJSON()).toEqual({ p_offset: 0 });
    return route.fulfill({ json: removed ? [] : [{
      id: otherId, email: "robin@example.com", display_name: "Robin Park", created_at: createdAt,
      last_active_at: "2026-10-01T12:00:00Z",
      groups: [{ id: groupId, name: "Baking club", role: "admin" }, { id: otherId, name: "Music club", role: "member" }],
    }] });
  });
  await page.route("**/api/account", (route) => {
    expect(route.request().postDataJSON()).toEqual({ userId: otherId });
    removed = true;
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/platform/users");
  const table = page.getByRole("table", { name: "All users (platform admin)" });
  await expect(table).toContainText("robin@example.com");
  await expect(table).toContainText("Baking club · Admin");
  await expect(table).toContainText("Music club · Member");
  await expect(table.locator("time")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Previous users" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next users" })).toBeDisabled();
  await table.getByRole("button", { name: "Delete account for Robin Park" }).click();
  await page.getByRole("button", { name: "Confirm permanent deletion" }).click();
  await expect(page.getByText("No users on this page.")).toBeVisible();
  expect(listRequests).toBe(2);
});

test("ordinary accounts cannot see or request the platform users list", async ({ page }) => {
  await configure(page);
  let listRequests = 0;
  page.on("request", (request) => {
    if (/\/rpc\/get_platform_(users|groups)/.test(request.url())) listRequests++;
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Account (alex@example.com)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All users (platform admin)" })).toHaveCount(0);
  await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
  for (const path of ["/platform/users", "/platform/groups"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
  }
  expect(listRequests).toBe(0);
});

for (const locale of ["en", "fi"] as const) {
  test(`platform administration has its own menu and separate views (${locale}) @mobile`, async ({ page }) => {
    await configure(page, true);
    await page.addInitScript((value) => localStorage.setItem("openjury:locale", value), locale);
    const menuLabel = locale === "fi" ? "Alustan ylläpito" : "Platform administration";
    const groupsLabel = locale === "fi" ? "Ryhmät" : "Groups";
    const usersLabel = locale === "fi" ? "Käyttäjät" : "Users";
    let groupsRequested = 0;
    let usersRequested = 0;
    page.on("request", (request) => {
      if (request.url().includes("/rpc/get_platform_groups")) groupsRequested++;
      if (request.url().includes("/rpc/get_platform_users")) usersRequested++;
    });
    await page.goto("/dashboard");
    const trigger = page.getByTitle(menuLabel, { exact: true });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("table", { name: /platform admin|alustan ylläpitäjä|palvelun ylläpitäjä/ })).toHaveCount(0);
    expect(groupsRequested).toBe(0);
    expect(usersRequested).toBe(0);
    await trigger.click();
    const menu = page.getByRole("navigation", { name: menuLabel });
    await expect(menu.getByRole("link", { name: groupsLabel, exact: true })).toHaveAttribute("href", "/platform/groups");
    await expect(menu.getByRole("link", { name: usersLabel, exact: true })).toHaveAttribute("href", "/platform/users");
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole("link", { name: usersLabel, exact: true }).click();
    await expect(page).toHaveURL(/\/platform\/users$/);
    await expect(page.getByRole("heading", { name: usersLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toContainText("robin@example.com");
    await expect(page.getByRole("table")).toHaveCount(1);
    expect(groupsRequested).toBe(0);
    expect(usersRequested).toBe(1);
    await trigger.click();
    await expect(menu.getByRole("link", { name: usersLabel, exact: true })).toHaveAttribute("aria-current", "page");
    await menu.getByRole("link", { name: groupsLabel, exact: true }).click();
    await expect(page).toHaveURL(/\/platform\/groups$/);
    await expect(page.getByRole("heading", { name: groupsLabel, exact: true })).toBeVisible();
    await expect(page.getByText(locale === "fi" ? "Ryhmiä ei ole vielä olemassa." : "No groups exist yet.")).toBeVisible();
    await expect(page.getByText("robin@example.com")).toHaveCount(0);
    expect(groupsRequested).toBe(1);
    expect(usersRequested).toBe(1);
    await trigger.click();
    await page.getByRole("button", { name: locale === "fi" ? "Tili (alex@example.com)" : "Account (alex@example.com)" }).click();
    await expect(menu).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("platform access checks fail closed without requesting either list", async ({ page }) => {
  await configure(page, true);
  let listRequests = 0;
  page.on("request", (request) => {
    if (/\/rpc\/get_platform_(users|groups)/.test(request.url())) listRequests++;
  });
  for (const failure of ["error", "invalid", "network"]) {
    await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, (route) =>
      failure === "network" ? route.abort() : route.fulfill({
        status: failure === "error" ? 500 : 200,
        json: failure === "error" ? { message: "Unavailable" } : "true",
      }));
    for (const path of ["/platform/groups", "/platform/users"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
      await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("table")).toHaveCount(0);
    }
  }
  expect(listRequests).toBe(0);
});

test("platform views do not load private data while authorization is pending", async ({ page }) => {
  await configure(page, true);
  let release: (() => void) | undefined;
  let listRequests = 0;
  await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: false });
  });
  page.on("request", (request) => {
    if (/\/rpc\/get_platform_(users|groups)/.test(request.url())) listRequests++;
  });
  await page.goto("/platform/users");
  await expect(page.getByRole("status")).toHaveText("Checking access…");
  await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(listRequests).toBe(0);
  await expect.poll(() => !!release).toBe(true);
  release!();
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  expect(listRequests).toBe(0);
});

test("signed-out visitors cannot see platform views or request their data", async ({ page }) => {
  await configure(page, true);
  await page.addInitScript(() => localStorage.removeItem("sb-foundation-auth-token"));
  let platformRequests = 0;
  page.on("request", (request) => {
    if (/\/rpc\/(is_platform_admin|get_platform_users|get_platform_groups)/.test(request.url())) platformRequests++;
  });
  for (const path of ["/platform/groups", "/platform/users"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
  }
  expect(platformRequests).toBe(0);
});

test("revoking platform access removes the menu and current view on focus", async ({ page }) => {
  await configure(page, true);
  let admin = true;
  await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, (route) => route.fulfill({ json: admin }));
  await page.goto("/platform/users");
  await expect(page.getByRole("table")).toContainText("robin@example.com");
  admin = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(page.getByLabel("Platform administration", { exact: true })).toHaveCount(0);
  await expect(page.getByText("robin@example.com")).toHaveCount(0);
});

test("platform users pagination requests batches of 100 and allows returning to previous users", async ({ page }) => {
  await configure(page, true);
  const offsets: number[] = [];
  await page.route(`${supabaseURL}/rest/v1/rpc/get_platform_users`, (route) => {
    const offset = route.request().postDataJSON().p_offset;
    offsets.push(offset);
    return route.fulfill({ json: offset === 100 ? [] : Array.from({ length: 100 }, (_, index) => ({
      id: `account-${index}`, email: `person${index}@example.com`, display_name: null,
      created_at: createdAt, last_active_at: null, groups: [],
    })) });
  });
  await page.goto("/platform/users");
  await expect(page.getByRole("table", { name: "All users (platform admin)" }).getByRole("row")).toHaveCount(101);
  await page.getByRole("button", { name: "Next users" }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(page.getByText("No users on this page.")).toBeVisible();
  await page.getByRole("button", { name: "Previous users" }).click();
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "All users (platform admin)" }).getByRole("row")).toHaveCount(101);
  expect(offsets).toEqual([0, 100, 0]);
});

test("activity recording is throttled across navigation and failures do not affect authentication", async ({ page }) => {
  await configure(page);
  let activity = 0;
  await page.route(`${supabaseURL}/rest/v1/rpc/record_my_activity`, (route) => {
    activity++;
    return route.fulfill({ status: 500, json: { message: "Activity unavailable" } });
  });
  await page.goto("/dashboard");
  await expect.poll(() => activity).toBe(1);
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account details" })).toBeVisible();
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(page.getByRole("button", { name: "Delete your account", exact: true })).toBeVisible();
  expect(activity).toBe(1);
});

test("revoked platform administration clears users and hides the list", async ({ page }) => {
  await configure(page, true);
  let admin = true;
  let listRequests = 0;
  await page.route(`${supabaseURL}/rest/v1/rpc/is_platform_admin`, (route) => route.fulfill({ json: admin }));
  await page.route(`${supabaseURL}/rest/v1/rpc/get_platform_users`, (route) => {
    listRequests++;
    return route.fulfill({ json: Array.from({ length: 100 }, (_, index) => ({
      id: `account-${index}`, email: `person${index}@example.com`, display_name: null,
      created_at: createdAt, last_active_at: null, groups: [],
    })) });
  });
  await page.goto("/platform/users");
  await expect(page.getByRole("table", { name: "All users (platform admin)" })).toContainText("person0@example.com");
  admin = false;
  await page.getByRole("button", { name: "Next users" }).click();
  await expect(page.getByRole("heading", { name: "All users (platform admin)" })).toHaveCount(0);
  await expect(page.getByText("person0@example.com", { exact: true })).toHaveCount(0);
  expect(listRequests).toBe(1);
});

test("demo profile deletion is unavailable and never calls the backend @mobile", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript", body: "window.__OPENJURY_CONFIG__ = {};",
  }));
  let deletions = 0;
  await page.route("**/api/account", (route) => { deletions++; return route.abort(); });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete your account", exact: true }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("no backend storage to delete");
  await expect(dialog.getByRole("button", { name: "Confirm permanent deletion" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(deletions).toBe(0);
});
