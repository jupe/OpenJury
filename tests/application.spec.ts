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
    await page.getByRole("link", { name: "Explore your dashboard" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your groups");
  if (configured) {
    await expect(signIn).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview a group" })).toHaveCount(0);
    await page.goto("/group/demo");
  } else {
    await expect(page.getByText("Configure Supabase to sign in and create groups.")).toBeVisible();
    await page.getByRole("link", { name: "Preview a group" }).click();
  }
  await expect(page).toHaveURL(/\/group\/demo$/);
  if (configured) {
    await expect(signIn).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview a competition" })).toHaveCount(0);
    await page.goto("/competition/demo");
  } else {
    await expect(page.getByText("Group: demo", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Preview a competition" }).click();
  }
  await expect(page).toHaveURL(/\/competition\/demo$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition");
  await page.getByRole("link", { name: "Preview admin view" }).click();
  await expect(page).toHaveURL(/\/competition\/demo\/admin$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  expect(privateRequests).toEqual([]);
});

test("competition and admin actions remain unavailable", async ({ page }) => {
  await page.goto("/competition/demo");
  await expect(page.getByRole("button", { name: "Submit entry (coming soon)" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Vote (coming soon)", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Preview admin view" }).click();
  await expect(page.getByText(/This public placeholder contains no private data/)).toBeVisible();
  for (const action of ["Start voting", "Stop voting", "Publish results"]) {
    await expect(page.getByRole("button", { name: `${action} (coming soon)` })).toBeDisabled();
  }
});

test("dynamic identifiers are displayed and preserved by admin links", async ({ page }) => {
  const id = "community-2026";
  await page.goto(`/group/${encodeURIComponent(id)}`);
  await expect(page.getByText(`Group: ${id}`, { exact: true })).toBeVisible();
  await page.goto(`/competition/${encodeURIComponent(id)}`);
  await expect(page.getByText(`Competition: ${id}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Preview admin view" })).toHaveAttribute(
    "href",
    `/competition/${encodeURIComponent(id)}/admin`,
  );
  await page.getByRole("link", { name: "Preview admin view" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Competition admin");
  await expect(page.getByText(`Competition: ${id}`, { exact: true })).toBeVisible();
});

test("mobile layout and main navigation", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/dashboard", `/group/${"a".repeat(100)}`, `/competition/${"b".repeat(100)}`, `/competition/${"b".repeat(100)}/admin`]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
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
  expect(Object.keys(config).sort()).toEqual(["SUPABASE_ANON_KEY", "SUPABASE_URL"]);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__OPENJURY_CONFIG__)).toEqual(config);
});
