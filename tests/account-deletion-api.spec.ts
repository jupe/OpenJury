import { expect, test } from "@playwright/test";
import { DELETE } from "../app/api/account/route";

test.describe.configure({ mode: "serial" });
const id = "22222222-2222-4222-8222-222222222222";
const authorization = ["Bearer", "account-test"].join(" ");
const env = {
  SUPABASE_URL: "https://backend.example.com",
  SUPABASE_ANON_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
};
let originalFetch: typeof fetch;
let previous: Record<string, string | undefined>;
let calls: { path: string; headers: Headers; body: Record<string, unknown> }[];
let authStatus: number;
let authorized: boolean;
let cleanupFails: boolean;
let finalFails: boolean;
let media: { name: string }[];

const request = (userId: unknown = id, token = true) => new Request("https://app.example.com/api/account", {
  method: "DELETE",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: authorization } : {}) },
  body: JSON.stringify({ userId }),
});

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = []; authStatus = 200; authorized = true; cleanupFails = false; finalFails = false;
  media = [{ name: "competition/entry/private.jpg" }];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const call = { path, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) };
    calls.push(call);
    if (path === "/auth/v1/user") {
      return Response.json(authStatus === 200 ? { id, aud: "authenticated" } : { message: "Invalid session" }, { status: authStatus });
    }
    if (path.endsWith("/prepare_account_deletion") || path.endsWith("/get_account_deletion_media")) {
      expect(call.headers.get("authorization")).toBe(authorization);
      expect(call.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
      expect(call.body.p_user_id).toBe(id);
      return authorized ? Response.json(media) : Response.json({ code: "42501", message: "Private detail" }, { status: 403 });
    }
    if (path === "/storage/v1/object/competition-submissions") {
      expect(calls.some((call) => call.path.endsWith("/prepare_account_deletion"))).toBe(true);
      expect(call.headers.get("apikey")).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
      expect(call.body.prefixes).toEqual(media.map((item) => item.name));
      if (cleanupFails) return Response.json({ message: "Private storage error" }, { status: 500 });
      media = [];
      return Response.json([]);
    }
    if (path.endsWith("/delete_account")) {
      expect(call.headers.get("authorization")).toBe(authorization);
      expect(call.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
      expect(media).toEqual([]);
      return finalFails ? Response.json({ code: "55000", message: "Private details" }, { status: 400 })
        : new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${path}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

test("requires configuration, valid target and authenticated authorized caller", async () => {
  expect((await DELETE(request(id, false))).status).toBe(401);
  expect((await DELETE(request("bad-id"))).status).toBe(400);
  expect(calls).toEqual([]);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  expect((await DELETE(request())).status).toBe(503);
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  authStatus = 401;
  expect((await DELETE(request())).status).toBe(401);
  authStatus = 200; authorized = false;
  expect((await DELETE(request())).status).toBe(403);
  expect(calls.some((call) => call.path.startsWith("/storage/") || call.path.endsWith("/delete_account"))).toBe(false);
});

test("removes authorized files via Storage before erasing account", async () => {
  const response = await DELETE(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ deleted: true });
  expect(calls.at(-1)?.path).toBe("/rest/v1/rpc/delete_account");
});

test("cleanup failure preserves account and retry completes deletion", async () => {
  cleanupFails = true;
  expect((await DELETE(request())).status).toBe(502);
  expect(calls.some((call) => call.path.endsWith("/delete_account"))).toBe(false);
  cleanupFails = false;
  expect((await DELETE(request())).status).toBe(200);
});

test("final database failure is retryable without leaking backend details", async () => {
  finalFails = true;
  const response = await DELETE(request());
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain("Private details");
  finalFails = false;
  expect((await DELETE(request())).status).toBe(200);
});
