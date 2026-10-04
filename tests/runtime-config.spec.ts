import { expect, test } from "@playwright/test";
import { runInNewContext } from "node:vm";
import { GET } from "../app/runtime-config.js/route";
import { getSupabase } from "../lib/supabase";

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PASSWORD_SIGN_IN",
] as const;
let previous: Record<string, string | undefined>;

test.beforeEach(() => {
  previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
});

test.afterEach(() => {
  for (const name of envNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

test("runtime script exposes only public fields and escapes script delimiters", async () => {
  const value = '</script><script>"quoted"\\\n\u2028\u2029';
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = value;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "must-not-be-exposed";
  const response = GET();
  const body = await response.text();
  expect(body).not.toContain("<");
  expect(body).not.toContain("\u2028");
  expect(body).not.toContain("\u2029");
  expect(body).not.toContain("must-not-be-exposed");
  const context = { window: {} as Window };
  runInNewContext(body, context);
  expect(context.window.__OPENJURY_CONFIG__).toEqual({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: value,
    PASSWORD_SIGN_IN: false,
  });
  process.env.SUPABASE_URL = "https://changed.supabase.co";
  expect(await GET().text()).toContain("https://changed.supabase.co");
});

test("password sign-in is exposed only when explicitly enabled", async () => {
  for (const [value, expected] of [["true", true], ["1", false], ["", false]] as const) {
    process.env.PASSWORD_SIGN_IN = value;
    const context = { window: {} as Window };
    runInNewContext(await GET().text(), context);
    expect(context.window.__OPENJURY_CONFIG__?.PASSWORD_SIGN_IN).toBe(expected);
  }
});

test("missing configuration fails closed; server client uses runtime public configuration", async () => {
  const context = { window: {} as Window };
  runInNewContext(await GET().text(), context);
  expect(context.window.__OPENJURY_CONFIG__).toEqual({
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    PASSWORD_SIGN_IN: false,
  });
  expect(() => getSupabase()).toThrow("Supabase is not configured");
  process.env.SUPABASE_URL = "https://runtime.supabase.co";
  process.env.SUPABASE_ANON_KEY = "public-runtime-anon";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-legacy-anon";
  const client = getSupabase();
  expect(client).toMatchObject({
    supabaseUrl: "https://runtime.supabase.co",
    supabaseKey: "public-runtime-anon",
  });
  expect(getSupabase()).toBe(client);
});
