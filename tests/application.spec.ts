import { expect, test } from "@playwright/test";

test("health endpoint @smoke", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ status: "ok" });
});

test("landing and preview navigation @smoke", async ({ page }) => {
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/rest\/v1\//.test(request.url())) privateRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page).toHaveTitle("OpenJury");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Competitions for every community",
  );
  const signIn = page.getByRole("heading", { name: "Sign in to OpenJury" });
  const setup = page.getByRole("heading", { name: "Setup required" });
  await expect(signIn.or(setup)).toBeVisible();
  const configured = await signIn.isVisible();
  if (configured) {
    await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).click();
  } else {
    await expect(page.getByText(/Demo mode · fictional sample content/)).toBeVisible();
    await page.getByRole("link", { name: "Open demo dashboard" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your groups");
  if (configured) {
    await expect(signIn).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview a group" })).toHaveCount(0);
    await page.goto("/group/demo");
  } else {
    await expect(page.getByRole("link", { name: "Northside Makers", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Northside Makers", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/group\/demo$/);
  if (configured) {
    await expect(signIn).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview a competition" })).toHaveCount(0);
    await page.goto("/competition/demo");
  } else {
    await expect(page.getByRole("heading", { name: "Northside Makers" })).toBeVisible();
    await page.getByRole("link", { name: "Spring Bake-off" }).click();
  }
  await expect(page).toHaveURL(/\/competition\/demo$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition");
  if (configured) {
    await expect(signIn).toBeVisible();
    await page.goto("/competition/demo/admin");
    await expect(signIn).toBeVisible();
    expect(privateRequests).toEqual([]);
    return;
  }
  await expect(page.getByRole("heading", { name: "Anonymous voting view example" })).toBeVisible();
  await page.getByRole("link", { name: "Admin review" }).first().click();
  await expect(page).toHaveURL(/\/competition\/demo\/admin$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await expect(page.getByRole("heading", { name: "Preliminary rankings example" })).toBeVisible();
  expect(privateRequests).toEqual([]);
});

test("demo views show fictional, read-only examples", async ({ page }) => {
  await page.goto("/competition/demo");
  await expect(page.getByText(/Demo mode · fictional sample content/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Submission view example" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anonymous voting view example" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Published results view example" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save submission" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save ballot" }).first()).toBeDisabled();
  await expect(page.getByLabel("Presentation").first()).toBeDisabled();
  await page.getByRole("link", { name: "Admin review" }).first().click();
  await expect(page.getByRole("heading", { name: "Private submission review example" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Competition attendees" })).toBeVisible();
  await expect(page.getByText("Sample member C", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preliminary rankings example" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disqualify" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Publish final results" })).toBeDisabled();
});

test("database identifiers stay hidden but are preserved by navigation links", async ({ page }) => {
  const id = "db68a1af-c7e9-437b-99bf-2641263c498e";
  await page.goto(`/group/${encodeURIComponent(id)}`);
  await expect(page.locator("body")).not.toContainText(id);
  await page.goto(`/competition/${encodeURIComponent(id)}`);
  await expect(page.locator("body")).not.toContainText(id);
  await expect(page.getByRole("link", { name: "Admin review" }).first()).toHaveAttribute(
    "href",
    `/competition/${encodeURIComponent(id)}/admin`,
  );
  await page.getByRole("link", { name: "Admin review" }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await expect(page.locator("body")).not.toContainText(id);
  await expect(page.getByRole("link", { name: "Participant view" })).toHaveAttribute(
    "href",
    `/competition/${encodeURIComponent(id)}`,
  );
});

test("mobile layout and main navigation", async ({ page }) => {
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
