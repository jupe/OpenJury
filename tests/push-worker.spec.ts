import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { removeDevicePush } from "../lib/push-client";

test("sign-out removes the server subscription even if browser unsubscription fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let deleted = false;
  let cleared = false;
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      serviceWorker: { getRegistration: async () => ({
        pushManager: { getSubscription: async () => ({
          endpoint: "https://web.push.apple.com/device",
          unsubscribe: async () => false,
        }) },
      }) },
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      removeItem: () => { cleared = true; },
    } });
    globalThis.fetch = async (_, options) => {
      expect(options?.method).toBe("DELETE");
      expect(JSON.parse(String(options?.body))).toEqual({ endpoint: "https://web.push.apple.com/device" });
      deleted = true;
      return Response.json({ subscribed: false });
    };
    await removeDevicePush("test-session");
    expect(deleted).toBe(true);
    expect(cleared).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("push worker always displays a visible notification and rejects off-origin click URLs", async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const notifications: Array<{ title: string; options: { data: { path: string } } }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://openjury.test" },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    registration: { showNotification: async (title: string, options: { data: { path: string } }) => { notifications.push({ title, options }); } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, URL });
  let pending: Promise<unknown> = Promise.resolve();
  const waitUntil = (promise: Promise<unknown>) => { pending = promise; };
  handlers.push({ data: { json: () => { throw new Error("Malformed"); } }, waitUntil });
  await pending;
  expect(notifications).toHaveLength(1);
  expect(notifications[0].title).toBe("OpenJury");
  handlers.push({ data: { json: () => ({ url: "https://attacker.test", body: "Update" }) }, waitUntil });
  await pending;
  expect(notifications[1].options.data.path).toBe("/");
  handlers.notificationclick({ notification: { close() {}, data: { path: "//attacker.test" } }, waitUntil });
  await pending;
  expect(opened).toEqual(["https://openjury.test/"]);
});

test("web-app manifest and icons support Home Screen installation @mobile", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ id: "/", display: "standalone", start_url: "/", scope: "/",
    icons: [{ src: "/icon-192", sizes: "192x192" }, { src: "/icon", sizes: "512x512" }] });
  for (const path of ["/icon-192", "/icon", "/apple-icon"]) {
    const icon = await request.get(path);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }
  const worker = await request.get("/sw.js");
  expect(worker.headers()["cache-control"]).toContain("no-store");
});
