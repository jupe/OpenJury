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
  // Signed-out visitors see the introduction; the demo signs in and shows the overview.
  // The demo's heading waits for its in-browser database, as other demo checks do.
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^(Competitions for every community|Welcome back.*)$/, { timeout: 60_000 },
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
  await page.getByRole("link", { name: "Profile" }).click();
  await demoExpect(page).toHaveURL(/\/profile$/);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Dashboard" }).click();
  await demoExpect(page).toHaveURL(/\/dashboard$/);
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Your groups");
  await page.getByRole("link", { name: "Northside Makers", exact: true }).click();
  await demoExpect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.getByRole("link", { name: "Spring Bake-off", exact: true }).click();
  await demoExpect(page).toHaveURL(/\/competition\/[^/]+$/);
  await demoExpect(page.getByRole("heading", { level: 1 })).toHaveText("Competition");
  await demoExpect(page.getByRole("heading", { name: "Anonymous entries" })).toBeVisible();
  await demoExpect(page.getByRole("button", { name: "Print blank certificate templates" })).toBeVisible();
  await demoExpect(page.getByRole("button", { name: "Print published winner certificates" })).toHaveCount(0);
  await expect(page.locator(".template-certificates .award-certificate")).toHaveCount(3);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => document.body.classList.add("print-award-certificates", "print-award-templates"));
  await expect(page.locator(".template-certificates")).toHaveCSS("display", "block");
  await expect(page.locator(".site-header")).toHaveCSS("display", "none");
  const pageSize = await page.locator(".template-certificates .award-certificate").first().evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });
  expect(pageSize.height).toBeGreaterThan(pageSize.width);
  expect(pageSize.width / pageSize.height).toBeCloseTo(210 / 297, 2);
  await page.evaluate(() => document.body.classList.remove("print-award-certificates", "print-award-templates"));
  await page.emulateMedia({ media: "screen" });
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

test("shared warm theme is present on public and sign-in screens @mobile", async ({ page, isMobile }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/runtime-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: 'window.__OPENJURY_CONFIG__ = {SUPABASE_URL: "https://foundation.supabase.co", SUPABASE_ANON_KEY: "public-test-anon"};',
  }));
  await page.route("https://foundation.supabase.co/**", (route) => route.abort());
  for (const path of ["/", "/dashboard", "/competitions", "/profile"]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 248, 240)");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("color", "rgb(45, 49, 66)");
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCSS("display", "flex");
    const primary = page.getByRole("button", { name: "Send sign-in link" });
    await expect(primary).toHaveCSS("background-color", "rgb(255, 107, 91)");
    await expect(primary).toHaveCSS("color", "rgb(45, 49, 66)");
    if (!isMobile) {
      await primary.hover();
      await expect(primary).toHaveCSS("background-color", "rgb(255, 130, 116)");
      await page.mouse.down();
      await expect(primary).toHaveCSS("background-color", "rgb(255, 117, 102)");
      await page.mouse.up();
    }
    await expect(page.getByRole("textbox", { name: "Email address" })).toHaveCSS("min-height", "48px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  if (await mobileNavigation.isVisible()) {
    await mobileNavigation.getByRole("link", { name: "Groups" }).click();
    await expect(mobileNavigation.getByRole("link", { name: "Groups" })).toHaveCSS("background-color", "rgb(255, 226, 218)");
  }
});

test("theme preference supports white, dark, and automatic system mode", async ({ page }) => {
  await page.goto("/");
  const account = page.getByRole("button", { name: /^Account/ });
  const signIn = page.getByRole("heading", { name: "Sign in to OpenJury" });
  await account.or(signIn).first().waitFor({ timeout: 60_000 });
  test.skip(await signIn.isVisible(), "Supabase is configured");

  await account.click();
  const theme = page.getByRole("combobox", { name: "Theme" });
  await expect(theme.locator("option")).toHaveText(["White", "Dark", "Auto"]);
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(11, 17, 32)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await account.click();
  await page.getByRole("combobox", { name: "Theme" }).selectOption("auto");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "white");
  await page.getByRole("combobox", { name: "Theme" }).selectOption("white");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "white");
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
  const ownEntry = page.getByRole("region", { name: "Your entry" });
  await demoExpect(ownEntry).toBeVisible();
  await demoExpect(ownEntry.getByText("You cannot vote on your own entry.")).toBeVisible();
  await demoExpect(ownEntry.getByRole("slider")).toHaveCount(0);
  await demoExpect(ownEntry.getByRole("img", { name: "Your submission image 1" })).toBeVisible();
  await demoExpect(page.getByText("Voted", { exact: true })).toHaveCount(2, { timeout: 30_000 });
  // The anonymous number assigned to Robin's own entry is hidden from the ballot.
  const ballots = page.getByRole("list").filter({ has: page.getByRole("slider") });
  const firstEntry = ballots.getByRole("listitem").first();
  const entryNumber = (await firstEntry.getByRole("heading").innerText()).match(/^Entry (\d+)/)?.[1];
  expect(entryNumber).toBeDefined();
  await firstEntry.getByRole("slider", { name: "Taste" }).fill("1");
  await demoExpect(page.getByRole("status").filter({ hasText: `Vote recorded · Entry ${entryNumber}` })).toBeVisible();
  await page.reload();
  const savedEntry = ballots.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: new RegExp(`^Entry ${entryNumber}\\b`) }),
  });
  await demoExpect(savedEntry.getByRole("slider", { name: "Taste" })).toHaveValue("1", { timeout: 60_000 });
});

test("database identifiers stay hidden but are preserved by navigation links", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "db68a1af-c7e9-437b-99bf-2641263c498e";
  await page.goto(`/group/${encodeURIComponent(id)}`);
  const signIn = page.getByRole("heading", { name: "Sign in to OpenJury" });
  await demoExpect(page.getByRole("button", { name: /^Account/ }).or(signIn)).toBeVisible({ timeout: 60_000 });
  await demoExpect(page.getByRole("heading", { name: "Group not found or access denied" }).or(signIn))
    .toBeVisible({ timeout: 60_000 });
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
