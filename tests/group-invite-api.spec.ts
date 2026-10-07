import { expect, test } from "@playwright/test";
import { POST } from "../app/api/groups/[groupId]/invite/route";

test.describe.configure({ mode: "serial" });

const groupId = "11111111-1111-4111-8111-111111111111";
const env = {
  SUPABASE_URL: "https://backend.example.com",
  SUPABASE_ANON_KEY: "public-test-key",
  RESEND_API_KEY: "private-test-email-key",
  COMPETITION_EMAIL_FROM: "jury@example.com",
  APP_URL: "https://jury.example.com",
};
let previous: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;
let authStatus: number;
let rpcError: string | null;
let providerStatus: number;
let providerThrows: boolean;
let groupFails: boolean;

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = [];
  authStatus = 200;
  rpcError = null;
  providerStatus = 200;
  providerThrows = false;
  groupFails = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) });
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") {
      return Response.json(authStatus === 200 ? { id: "admin", aud: "authenticated" }
        : { message: "Private auth failure" }, { status: authStatus });
    }
    if (path === "/rest/v1/rpc/invite_group_member_by_email") {
      return rpcError ? Response.json({ code: rpcError, message: "Private database detail" }, { status: 400 })
        : new Response(null, { status: 204 });
    }
    if (path === "/rest/v1/groups") {
      return groupFails ? Response.json({ message: "Private group failure" }, { status: 500 })
        : Response.json({ name: "Baking club" });
    }
    if (url === "https://api.resend.com/emails") {
      if (providerThrows) throw new TypeError("Private timeout detail");
      return Response.json({ id: "provider-id", message: "Private provider detail" }, { status: providerStatus });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function request(email: unknown = " NEW@example.com ", token = "test-session-token", id = groupId, body?: string) {
  return POST(new Request(`https://attacker.example/api/groups/${id}/invite`, {
    method: "POST",
    headers: token ? { authorization: ["Bearer", token].join(" ") } : {},
    body: body ?? JSON.stringify({ email }),
  }), { params: Promise.resolve({ groupId: id }) });
}

test("rejects missing sessions and invalid IDs or addresses before upstream calls", async () => {
  expect((await request("valid@example.com", "")).status).toBe(401);
  expect((await request("valid@example.com", "session", "invalid")).status).toBe(400);
  expect((await request("valid@example.com", "session", groupId, "{")).status).toBe(400);
  for (const email of [null, 42, "", "invalid", "a@b.com\nbcc@evil.com", "a".repeat(321) + "@example.com"]) {
    expect((await request(email)).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("missing or unsafe configuration fails before saving a pending invite", async () => {
  for (const name of ["RESEND_API_KEY", "COMPETITION_EMAIL_FROM", "APP_URL"]) {
    delete process.env[name];
    expect((await request()).status).toBe(503);
    process.env[name] = env[name as keyof typeof env];
  }
  for (const url of ["https://example.com/path", "https://user@example.com", "http://example.com", "https://example.com/?next=evil"]) {
    process.env.APP_URL = url;
    expect((await request()).status).toBe(503);
  }
  process.env.APP_URL = env.APP_URL;
  process.env.COMPETITION_EMAIL_FROM = "sender@example.com\r\nBcc: other@example.com";
  expect((await request()).status).toBe(503);
  expect(calls).toEqual([]);
});

test("authentication and RPC permissions gate email delivery without leaking errors", async () => {
  authStatus = 401;
  expect((await request()).status).toBe(401);
  authStatus = 200;
  for (const [code, status] of [["42501", 403], ["22023", 400], ["XX000", 502]] as const) {
    rpcError = code;
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("Private");
  }
  expect(calls.some((call) => call.url.includes("resend"))).toBe(false);
});

test("saves under the user's permissions and sends a private invitation to the trusted dashboard URL", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ invited: true, emailSent: true });
  const rpc = calls.find((call) => call.url.endsWith("/invite_group_member_by_email"))!;
  expect(rpc.body).toEqual({ p_group_id: groupId, p_email: "new@example.com" });
  expect(rpc.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
  expect(rpc.headers.get("authorization")).toBe(["Bearer", "test-session-token"].join(" "));
  const email = calls.find((call) => call.url === "https://api.resend.com/emails")!;
  expect(email.headers.get("authorization")).toBe(["Bearer", env.RESEND_API_KEY].join(" "));
  expect(email.body).toEqual({
    from: env.COMPETITION_EMAIL_FROM,
    to: ["new@example.com"],
    subject: "You have been invited to an OpenJury group",
    text: 'You have been invited to "Baking club" on OpenJury.\nSign in with new@example.com to join the group:\nhttps://jury.example.com/dashboard',
  });
  expect(email.body).not.toHaveProperty("html");
  expect(JSON.stringify(email.body)).not.toContain("attacker.example");
});

test("provider and network failures report pending state and allow explicit resends", async () => {
  for (const failure of ["provider", "network", "group"]) {
    providerStatus = failure === "provider" ? 429 : 200;
    providerThrows = failure === "network";
    groupFails = failure === "group";
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      invited: true, error: "Invitation saved, but email delivery failed. Please retry.",
    });
  }
  providerThrows = false;
  groupFails = false;
  expect(await (await request()).json()).toEqual({ invited: true, emailSent: true });
});
