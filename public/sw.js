self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    // Every push must display a notification, including malformed payloads.
  }
  const path = typeof payload.url === "string"
    && /^\/competition\/[0-9a-f-]{36}$/i.test(payload.url) ? payload.url : "/";
  event.waitUntil(self.registration.showNotification("OpenJury", {
    body: typeof payload.body === "string" ? payload.body : "Open OpenJury to see competition updates.",
    icon: "/apple-icon",
    tag: typeof payload.tag === "string" ? payload.tag : "openjury",
    data: { path },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path;
  const destination = new URL(
    typeof path === "string" && /^\/competition\/[0-9a-f-]{36}$/i.test(path) ? path : "/",
    self.location.origin,
  ).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url === destination && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
