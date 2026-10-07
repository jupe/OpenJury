import { expect, test } from "@playwright/test";
import { POST } from "../app/api/competitions/[competitionId]/start/route";

test.describe.configure({ mode: "serial" });

const competitionId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const claimToken = "33333333-3333-4333-8333-333333333333";
const env = {
  SUPABASE_URL: "https://backend.example.com",
  SUPABASE_ANON_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "private-test-service-key",
  RESEND_API_KEY: "private-test-email-key",
  COMPETITION_EMAIL_FROM: "jury@example.com",
  APP_URL: "https://jury.example.com",
};
let previous: Record<string, string | undefined>;
let originalFetch: typeof fetch;
type Call = { url: string; headers: Headers; body: Record<string, unknown>; at: number };
let calls: Call[];
let authStatus: number;
let startError: string | null;
let providerStatus: number;
let providerThrows: boolean;
let finishFails: boolean;
let claimFails: boolean;
let completed: boolean;
let claimed: boolean;
let originalNow: typeof Date.now;
let clockOffset: number;
let finishAdvance: number;
let extraRecipient: boolean;
const payload = {
  from: env.COMPETITION_EMAIL_FROM,
  to: ["private-member@example.com"],
  subject: "Competition started: Bake-off",
  text: `The competition "Bake-off" in "Baking club" has started.\nhttps://jury.example.com/competition/${competitionId}`,
};

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = [];
  authStatus = 200;
  startError = null;
  providerStatus = 200;
  providerThrows = false;
  finishFails = false;
  claimFails = false;
  completed = true;
  claimed = false;
  clockOffset = 0;
  finishAdvance = 0;
  extraRecipient = false;
  originalNow = Date.now;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")), at: Date.now() };
    calls.push(call);
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") {
      return Response.json(authStatus === 200 ? { id: "admin", aud: "authenticated" }
        : { message: "Invalid token" }, { status: authStatus });
    }
    if (path === "/rest/v1/rpc/start_competition") {
      return startError
        ? Response.json({ code: startError, message: "Private database detail" }, { status: 400 })
        : Response.json("submission");
    }
    if (path === "/rest/v1/rpc/claim_competition_start_email") {
      if (claimFails) return Response.json({ message: "Private claim error" }, { status: 500 });
      if (claimed) return Response.json([]);
      if (extraRecipient) {
        extraRecipient = false;
        return Response.json([{
          id: "44444444-4444-4444-8444-444444444444",
          claim_token: claimToken, payload: { ...payload, to: ["second-private-member@example.com"] },
        }]);
      }
      claimed = true;
      return Response.json([{ id: recipientId, claim_token: claimToken, payload }]);
    }
    if (url === "https://api.resend.com/emails") {
      if (providerThrows) throw new TypeError("Network timeout");
      return Response.json(providerStatus === 200 ? { id: "provider-id" } : { message: "Private failure" },
        { status: providerStatus });
    }
    if (path === "/rest/v1/rpc/finish_competition_start_email") {
      clockOffset += finishAdvance;
      return finishFails ? Response.json({ message: "Private finish error" }, { status: 500 })
        : new Response(null, { status: 204 });
    }
    if (path === "/rest/v1/rpc/competition_start_emails_sent") return Response.json(completed);
    throw new Error(`Unexpected upstream: ${url}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function request(token = "test-session-token", id = competitionId) {
  return POST(new Request(`https://attacker.example/api/competitions/${id}/start`, {
    method: "POST", headers: token ? { authorization: ["Bearer", token].join(" ") } : {},
  }), { params: Promise.resolve({ competitionId: id }) });
}

test("rejects missing sessions and malformed IDs without upstream calls", async () => {
  expect((await request("")).status).toBe(401);
  expect((await request("session", "invalid")).status).toBe(400);
  expect(calls).toEqual([]);
});

test("configuration fails closed before starting", async () => {
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "COMPETITION_EMAIL_FROM", "APP_URL"]) {
    delete process.env[name];
    expect((await request()).status).toBe(503);
    process.env[name] = env[name as keyof typeof env];
  }
  for (const value of ["https://example.com/path", "https://user@example.com", "http://example.com", "https://example.com/?next=evil"]) {
    process.env.APP_URL = value;
    expect((await request()).status).toBe(503);
  }
  process.env.APP_URL = env.APP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "invalid key with whitespace";
  expect((await request()).status).toBe(503);
  expect(calls).toEqual([]);
});

test("verifies sessions and maps permission/state failures without delivery", async () => {
  authStatus = 401;
  expect((await request()).status).toBe(401);
  expect(calls).toHaveLength(1);
  authStatus = 200;
  for (const [code, expectedStatus] of [["42501", 403], ["55000", 409], ["XX000", 502]] as const) {
    startError = code;
    const response = await request();
    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).not.toContain("Private");
  }
  expect(calls.some((call) => call.url.includes("resend") || call.url.includes("claim_competition"))).toBe(false);
});

test("starts as the user and privately delivers frozen plain text with service-only RPCs", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ started: true, notificationsSent: true });
  const start = calls.find((call) => call.url.endsWith("/start_competition"))!;
  expect(start.body).toEqual({ p_competition_id: competitionId, p_notify: true });
  expect(start.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
  expect(start.headers.get("authorization")).toBe(["Bearer", "test-session-token"].join(" "));
  const claim = calls.find((call) => call.url.endsWith("/claim_competition_start_email"))!;
  expect(claim.headers.get("apikey")).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
  expect(claim.body).toEqual({
    p_competition_id: competitionId, p_from: env.COMPETITION_EMAIL_FROM, p_origin: env.APP_URL,
  });
  const email = calls.find((call) => call.url === "https://api.resend.com/emails")!;
  expect(email.body).toEqual(payload);
  expect(email.body).not.toHaveProperty("html");
  expect(email.headers.get("idempotency-key")).toBe(`competition-start-${recipientId}`);
  expect(email.headers.get("authorization")).toBe(["Bearer", env.RESEND_API_KEY].join(" "));
  expect(email.body.text).not.toContain("attacker.example");
  expect(calls.find((call) => call.url.endsWith("/finish_competition_start_email"))!.body).toEqual({
    p_id: recipientId, p_claim_token: claimToken, p_sent: true,
  });
});

test("provider failures preserve successful start and retry uses the same key and payload", async () => {
  providerStatus = 429;
  const failed = await request();
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.find((call) => call.url.endsWith("/finish_competition_start_email"))!.body.p_sent).toBe(false);
  providerStatus = 200;
  claimed = false;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  const emails = calls.filter((call) => call.url === "https://api.resend.com/emails");
  expect(emails).toHaveLength(2);
  expect(emails[0].body).toEqual(emails[1].body);
  expect(emails[0].headers.get("idempotency-key")).toBe(emails[1].headers.get("idempotency-key"));
});

test("network, claim, acknowledgement and pending leases return partial success without private details", async () => {
  for (const failure of ["network", "claim", "finish", "pending"]) {
    claimed = false;
    providerThrows = failure === "network";
    claimFails = failure === "claim";
    finishFails = failure === "finish";
    completed = failure !== "pending";
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ started: true, notificationsSent: false });
  }
});

test("already delivered or leased outbox never sends without a claim", async () => {
  claimed = true;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  expect(calls.some((call) => call.url.includes("resend"))).toBe(false);
  completed = false;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.some((call) => call.url.includes("resend"))).toBe(false);
});

test("request time budget stops claiming more recipients and preserves partial success", async () => {
  const now = originalNow();
  Date.now = () => now + clockOffset;
  finishAdvance = 23_001;
  completed = false;
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.filter((call) => call.url.endsWith("/claim_competition_start_email"))).toHaveLength(1);
  expect(calls.filter((call) => call.url === "https://api.resend.com/emails")).toHaveLength(1);
});

test("paces multiple provider requests below Resend's default two-per-second limit", async () => {
  extraRecipient = true;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  const attempts = calls.filter((call) => call.url === "https://api.resend.com/emails");
  expect(attempts).toHaveLength(2);
  expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(550);
});
