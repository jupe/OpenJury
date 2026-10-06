import { expect, test, type Page } from "@playwright/test";

// The demo runs Postgres in the browser, which is slow in WebKit and under parallel load.
const demoExpect = expect.configure({ timeout: 30_000 });

test("health endpoint @smoke", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ status: "ok" });
});

async function checkLandingNavigation(page: Page) {
  test.setTimeout(120_000);
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/rest\/v1\//.test(request.url())) privateRequests.push(request.url());
  });
  await page.goto("/");
  await demoExpect(page).toHaveTitle("OpenJury");
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Competitions for every community",
  );
  const signIn = page.getByRole("heading", { name: "Sign in to OpenJury" });
  // Without Supabase configuration the app runs on an in-browser demo database.
  const demo = page.getByRole("complementary", { name: "Demo mode" });
  await demoExpect(signIn.or(demo)).toBeVisible();
  const configured = await signIn.isVisible();
  if (configured) {
    await demoExpect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
    for (const path of ["/dashboard", "/group/demo", "/competition/demo", "/competition/demo/admin"]) {
      await page.goto(path);
      await demoExpect(signIn).toBeVisible();
    }
    demoExpect(privateRequests).toEqual([]);
    return;
  }
  await page.getByRole("button", { name: /^Account/ }).click({ timeout: 60_000 });
  await page.getByRole("link", { name: "Your groups" }).click();
  await demoExpect(page).toHaveURL(/\/dashboard$/);
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Your groups");
  await page.getByRole("link", { name: "Northside Makers", exact: true }).click();
  await demoExpect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.getByRole("link", { name: "Spring Bake-off", exact: true }).click();
  await demoExpect(page).toHaveURL(/\/competition\/[^/]+$/);
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Competition");
  await demoExpect(page.getByRole("heading", { name: "Anonymous entries" })).toBeVisible();
  await page.getByRole("link", { name: "Manage competition" }).click();
  await demoExpect(page).toHaveURL(/\/competition\/[^/]+\/admin$/);
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await demoExpect(page.getByRole("heading", { name: "Competition attendees" })).toBeVisible();
  demoExpect(privateRequests).toEqual([]);
}

test("landing and preview navigation @smoke", async ({ page }) => {
  await checkLandingNavigation(page);
});

test("configured signed-out smoke navigation @mobile", async ({ page }) => {
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'window.__OPENJURY_CONFIG__ = {SUPABASE_URL: "https://foundation.supabase.co", SUPABASE_ANON_KEY: "public-test-anon"};',
  }));
  await page.route("https://foundation.supabase.co/**", (route) => route.abort());
  await checkLandingNavigation(page);
  await expect(page.getByRole("heading", { name: "Sign in to OpenJury" })).toBeVisible();
});

test("demo personas vote on fictional data saved in the browser", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/dashboard");
  const demo = page.getByRole("complementary", { name: "Demo mode" });
  const isDemo = await demo.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  test.skip(!isDemo, "Supabase is configured");
  await demo.getByLabel("Viewing as").selectOption({ label: "Robin Park · Member" }, { timeout: 60_000 });
  await demoExpect(page.getByRole("button", { name: "Account (robin@demo.openjury.app)" })).toBeVisible();
  await page.getByRole("link", { name: "Northside Makers", exact: true }).click();
  await page.getByRole("link", { name: "Spring Bake-off", exact: true }).click();
  // Robin's seeded ballots are already saved; moving a slider updates them.
  await demoExpect(page.getByText("Voted", { exact: true })).toHaveCount(2, { timeout: 30_000 });
  // Anonymous entries are listed in a different order on each load, so follow one by number.
  const entry = () => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /^Entry 1\b/ }) });
  await entry().getByRole("slider", { name: "Taste" }).fill("1");
  await demoExpect(page.getByRole("status").filter({ hasText: "Vote recorded · Entry 1" })).toBeVisible();
  await page.reload();
  await demoExpect(entry().getByRole("slider", { name: "Taste" })).toHaveValue("1", { timeout: 60_000 });
});

test("database identifiers stay hidden but are preserved by navigation links", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "db68a1af-c7e9-437b-99bf-2641263c498e";
  await page.goto(`/group/${encodeURIComponent(id)}`);
  await demoExpect(page.getByRole("main")).toBeVisible();
  await demoExpect(page.locator("body")).not.toContainText(id);
  await page.goto(`/competition/${encodeURIComponent(id)}`);
  await demoExpect(page.locator("body")).not.toContainText(id);
  const demo = page.getByRole("complementary", { name: "Demo mode" });
  if (!(await demo.waitFor({ timeout: 60_000 }).then(() => true, () => false))) return;
  // In the demo, real identifiers appear only in link targets.
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Northside Makers", exact: true }).click({ timeout: 60_000 });
  const competition = page.getByRole("link", { name: "Spring Bake-off", exact: true });
  const href = await competition.getAttribute("href");
  const competitionId = decodeURIComponent(href!.split("/").at(-1)!);
  const groupId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await demoExpect(page.locator("body")).not.toContainText(groupId);
  await demoExpect(page.locator("body")).not.toContainText(competitionId);
  await competition.click();
  await demoExpect(page.getByRole("link", { name: "Manage competition" })).toHaveAttribute(
    "href",
    `/competition/${encodeURIComponent(competitionId)}/admin`,
  );
  await page.getByRole("link", { name: "Manage competition" }).click();
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await demoExpect(page.locator("body")).not.toContainText(competitionId);
  await demoExpect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Spring Bake-off" })).toHaveAttribute(
    "href",
    `/competition/${encodeURIComponent(competitionId)}`,
  );
});

test("mobile layout and main navigation @mobile", async ({ page }) => {
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'window.__OPENJURY_CONFIG__ = {SUPABASE_URL: "https://foundation.supabase.co", SUPABASE_ANON_KEY: "public-test-anon"};',
  }));
  await page.route("https://foundation.supabase.co/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/dashboard", `/group/${"a".repeat(100)}`, `/competition/${"b".repeat(100)}`, `/competition/${"b".repeat(100)}/admin`]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(mobileNavigation.getByRole("link", { name: "Groups" })).toHaveAttribute("href", "/dashboard");
    await expect(mobileNavigation).toHaveCSS("position", "fixed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await mobileNavigation.getByRole("link", { name: "Groups" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(mobileNavigation.getByRole("link", { name: "Groups" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation").getByRole("link", { name: "OpenJury" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competitions for every community");
});

test("runtime public configuration is uncached and injected @smoke", async ({ page, request }) => {
  const response = await request.get("/runtime-config.js");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/javascript");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const script = await response.text();
  const prefix = "window.__OPENJURY_CONFIG__ = ";
  expect(script.startsWith(prefix)).toBe(true);
  const config = JSON.parse(script.slice(prefix.length).trim().replace(/;$/, ""));
  expect(Object.keys(config).sort()).toEqual(["PASSWORD_SIGN_IN", "SUPABASE_ANON_KEY", "SUPABASE_URL"]);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__OPENJURY_CONFIG__)).toEqual(config);
});
