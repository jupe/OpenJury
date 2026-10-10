export const PUSH_OWNER_KEY = "openjury:push-owner";

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isHomeScreen() {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function removeDevicePush(token: string) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) {
    localStorage.removeItem(PUSH_OWNER_KEY);
    return;
  }
  // Attempt both paths: either can stop delivery when the other is unavailable.
  const unsubscribed = await subscription.unsubscribe().catch(() => false);
  const response = await fetch("/api/push/subscriptions", {
    method: "DELETE",
    headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!unsubscribed && !response?.ok) throw new Error("Unable to disable notifications");
  localStorage.removeItem(PUSH_OWNER_KEY);
}
