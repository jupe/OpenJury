"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";
import { isHomeScreen, isIOS, PUSH_OWNER_KEY, removeDevicePush } from "@/lib/push-client";

type Availability = "loading" | "demo" | "ios-only" | "install" | "unsupported" | "unconfigured" | "ready";

export default function PushNotifications() {
  const { client, session } = useAuth();
  const { t, locale } = useLocale();
  const [availability, setAvailability] = useState<Availability>("loading");
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      let state: Availability = "ready";
      if (session.access_token.startsWith("demo-")) state = "demo";
      else if (!isIOS()) state = "ios-only";
      else if (!isHomeScreen()) state = "install";
      else if (!window.isSecureContext || !("serviceWorker" in navigator)
        || !("PushManager" in window) || !("Notification" in window)) state = "unsupported";
      if (state !== "ready") {
        if (active) setAvailability(state);
        return;
      }
      try {
        const response = await fetch("/api/push/subscriptions", { signal: AbortSignal.timeout(10_000) });
        const config = await response.json();
        if (!response.ok || typeof config.publicKey !== "string") throw new Error("Unconfigured");
        await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        const worker = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Service worker unavailable")), 10_000)),
        ]);
        const subscription = await worker.pushManager.getSubscription();
        const ownSubscription = localStorage.getItem(PUSH_OWNER_KEY) === session.user.id;
        if (subscription && !ownSubscription && !await subscription.unsubscribe()) {
          throw new Error("Unable to detach previous subscription");
        }
        if (active) {
          setRegistration(worker);
          setPublicKey(config.publicKey);
          setEnabled(Boolean(subscription && ownSubscription));
          setAvailability("ready");
        }
      } catch {
        if (active) setAvailability("unconfigured");
      }
    })();
    return () => { active = false; };
  }, [session.user.id, session.access_token]);

  async function enable() {
    if (!registration || busy) return;
    // iOS requires requesting permission directly in the button's user gesture.
    const permission = Notification.requestPermission();
    setBusy(true);
    setMessage("");
    let subscription: PushSubscription | null = null;
    try {
      if (await permission !== "granted") {
        setMessage("Notifications were not allowed. Check notification settings for this Home Screen app.");
        return;
      }
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
      subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) throw new Error("Authentication required");
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { Authorization: ["Bearer", data.session.access_token].join(" "), "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Unable to enable notifications");
      localStorage.setItem(PUSH_OWNER_KEY, session.user.id);
      setEnabled(true);
    } catch {
      await subscription?.unsubscribe().catch(() => false);
      setMessage("Unable to enable notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) throw new Error("Authentication required");
      await removeDevicePush(data.session.access_token);
      setEnabled(false);
    } catch {
      setEnabled(Boolean(await registration?.pushManager.getSubscription()));
      setMessage("Unable to disable notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const hints: Record<Availability, string> = {
    loading: "Loading notification settings…",
    demo: "Push notifications are unavailable in the demo.",
    "ios-only": "Push notifications are available for iPhone and iPad Home Screen apps. Android support is planned for a later phase.",
    install: "On iOS 16.4 or later, use Share → Add to Home Screen, then open OpenJury from your Home Screen to enable notifications.",
    unsupported: "Notifications require iOS 16.4 or later and a secure Home Screen app.",
    unconfigured: "Push notifications are not configured or could not be loaded.",
    ready: enabled ? "Notifications are enabled on this device." : "Receive notifications when submissions open, voting opens, or results are published.",
  };
  return (
    <Card title={t("iOS notifications")}>
      <p role="status">{t(hints[availability])}</p>
      {availability === "ready" && (
        <Button disabled={busy} onClick={() => void (enabled ? disable() : enable())}>
          {t(busy ? "Updating…" : enabled ? "Disable notifications" : "Enable notifications")}
        </Button>
      )}
      {message && <p role="alert">{t(message)}</p>}
    </Card>
  );
}
