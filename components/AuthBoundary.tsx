"use client";

import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getEnabledSocialProviders, getSupabase, passwordSignInEnabled, type SocialProvider } from "@/lib/supabase";
import Button from "@/components/Button";
import Card from "@/components/Card";
import AccountMenu from "@/components/AccountMenu";
import DemoToolbar from "@/components/DemoToolbar";
import { useLocale } from "@/lib/i18n";

// Supabase Auth refuses a new sign-in email to the same address for 60 seconds
// (GOTRUE_SMTP_MAX_FREQUENCY), and each new link invalidates the previous one.
const LINK_COOLDOWN_SECONDS = 60;

function isRunningAsApp() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function subscribeToAppMode(listener: () => void) {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function getServerAppMode() {
  return false;
}

const AuthContext = createContext<{ client: SupabaseClient; session: Session; demo: boolean } | null>(null);

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Authentication is required.");
  return auth;
}

export default function AuthBoundary({ children, signedOut }: {
  children: ReactNode;
  /** Shown above the sign-in form only, e.g. a landing introduction. */
  signedOut?: ReactNode;
}) {
  const { t } = useLocale();
  const appMode = useSyncExternalStore(subscribeToAppMode, isRunningAsApp, getServerAppMode);
  const [client, setClient] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkToken, setLinkToken] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [pending, setPending] = useState(false);
  const [oauthProvider, setOauthProvider] = useState<SocialProvider["id"] | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const currentSession = useRef<Session | null>(null);
  const confirmingLink = useRef(false);
  const translate = useRef(t);
  const emailInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    translate.current = t;
  }, [t]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let unsubscribe = () => {};
    const authRevision = revision;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const invitedEmail = hash.get("email");
      if (invitedEmail) {
        setEmail(invitedEmail);
        hash.delete("email");
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash.size ? `#${hash}` : ""}`);
      }
      // Email previews may run JavaScript; only a deliberate click may redeem this token.
      const token = hash.get("token_hash");
      if (token) setLinkToken(token);
      const error = hash.get("error_description") || query.get("error_description") || hash.get("error") || query.get("error");
      if (error) {
        setLinkError(translate.current("Sign-in failed: {error}. Please try again.", { error }));
        for (const key of ["error", "error_code", "error_description"]) {
          hash.delete(key);
          query.delete(key);
        }
        window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}${hash.size ? `#${hash}` : ""}`);
      }
      const initialRevision = revision.current;
      try {
        let supabase: SupabaseClient;
        try {
          supabase = getSupabase();
        } catch (error) {
          if (!(error instanceof Error && error.message.startsWith("Supabase is not configured."))) throw error;
          // Without a backend, run the real app against an in-browser demo database.
          supabase = (await import("@/lib/demo/client")).getDemoClient();
          if (!active) return;
          setDemo(true);
        }
        setClient(supabase);
        const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
          // getSession reports failures that INITIAL_SESSION hides.
          if (!active || event === "INITIAL_SESSION") return;
          revision.current++;
          currentSession.current = nextSession;
          setSession(nextSession);
          setSessionError("");
          setActionError("");
          setMessage("");
          setLoading(false);
        });
        unsubscribe = () => data.subscription.unsubscribe();
        const initialized = await supabase.auth.initialize();
        if (initialized.error && !error) throw initialized.error;
        const result = await supabase.auth.getSession();
        if (active && revision.current === initialRevision) {
          if (result.error) {
            setSession(null);
            setSessionError(translate.current("Unable to load your session: {error}", { error: translate.current(result.error.message) }));
          } else {
            currentSession.current = result.data.session;
            setSession(result.data.session);
          }
          setLoading(false);
        }
      } catch (error) {
        if (!active || revision.current !== initialRevision) return;
        setSessionError(translate.current("Unable to load your session: {error}", {
          error: error instanceof Error ? translate.current(error.message) : translate.current("Check the public Supabase configuration."),
        }));
        setLoading(false);
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
      authRevision.current++;
      unsubscribe();
    };
  }, []);

  async function confirmLink() {
    if (!client || !linkToken || confirmingLink.current) return;
    confirmingLink.current = true;
    setPending(true);
    setLinkError("");
    const hash = new URLSearchParams(window.location.hash.slice(1));
    hash.delete("token_hash");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash.size ? `#${hash}` : ""}`);
    try {
      const { error } = await client.auth.verifyOtp({ token_hash: linkToken, type: "email" });
      if (!mounted.current) return;
      if (error) setLinkError(t("This sign-in link has expired or could not be verified. Request a new link below."));
    } catch {
      if (mounted.current) setLinkError(t("This sign-in link has expired or could not be verified. Request a new link below."));
    } finally {
      if (mounted.current) {
        setLinkToken("");
        setPending(false);
      }
      confirmingLink.current = false;
    }
  }

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || pending || cooldown > 0) return;
    const requestRevision = revision.current;
    setPending(true);
    setActionError("");
    setMessage("");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/dashboard`, shouldCreateUser: true },
      });
      if (!mounted.current || revision.current !== requestRevision) return;
      if (error?.status === 429) {
        const wait = Number(/after (\d+) seconds/.exec(error.message)?.[1]);
        setCooldown(Number.isInteger(wait) && wait > 0 ? wait : LINK_COOLDOWN_SECONDS);
        setActionError(t(appMode ? "A sign-in code was sent recently. Check your email or wait before requesting a new one."
          : "A sign-in link was sent recently. Check your email, including the spam folder, or wait before requesting a new one."));
      } else if (error) setActionError(t(appMode ? "Unable to send sign-in code: {error}" : "Unable to send sign-in link: {error}", { error: t(error.message) }));
      else {
        setCooldown(LINK_COOLDOWN_SECONDS);
        setMessage(t(appMode ? "Check your email for a sign-in code." : "Check your email for a sign-in link."));
      }
    } catch {
      if (mounted.current && revision.current === requestRevision) setActionError(t(appMode ? "Unable to send sign-in code. Please try again." : "Unable to send sign-in link. Please try again."));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || pending || !emailInput.current?.reportValidity()) return;
    const requestRevision = revision.current;
    setPending(true);
    setVerifyingCode(true);
    setActionError("");
    setMessage("");
    try {
      const { error } = await client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (!mounted.current || revision.current !== requestRevision) return;
      if (error) setActionError(t("This code is incorrect, expired, or could not be verified. Try again or request a new sign-in email."));
    } catch {
      if (mounted.current && revision.current === requestRevision) {
        setActionError(t("Unable to verify the code. Please try again."));
      }
    } finally {
      if (mounted.current) {
        setCode("");
        setPending(false);
        setVerifyingCode(false);
      }
    }
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || pending) return;
    const requestRevision = revision.current;
    setPending(true);
    setActionError("");
    setMessage("");
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (!mounted.current || revision.current !== requestRevision) return;
      if (error) setActionError(t("Unable to sign in: {error}", { error: t(error.message) }));
    } catch {
      if (mounted.current && revision.current === requestRevision) setActionError(t("Unable to sign in. Please try again."));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function signInWithProvider(provider: SocialProvider) {
    if (!client || pending || demo || !getEnabledSocialProviders().some(({ id }) => id === provider.id)) return;
    const requestRevision = revision.current;
    setPending(true);
    setOauthProvider(provider.id);
    setActionError("");
    setMessage("");
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: provider.id,
        options: { redirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
    } catch (error) {
      if (!mounted.current || revision.current !== requestRevision) return;
      setActionError(t("Unable to sign in with {provider}: {error}", {
        provider: provider.name,
        error: error instanceof Error ? t(error.message) : t("Please try again."),
      }));
      setPending(false);
      setOauthProvider(null);
    }
  }

  async function signOut() {
    if (!client || signingOut) return;
    const requestRevision = revision.current;
    setSigningOut(true);
    setActionError("");
    try {
      const { error } = await client.auth.signOut();
      if (!mounted.current) return;
      if (error && (revision.current === requestRevision || !currentSession.current)) {
        setActionError(t("Unable to complete sign out on the server: {error}. Your local session may already be cleared.", { error: t(error.message) }));
      } else if (!error && revision.current === requestRevision) {
        currentSession.current = null;
        setSession(null);
      }
    } catch {
      if (mounted.current && (revision.current === requestRevision || !currentSession.current)) setActionError(t("Unable to complete sign out. Your local session may already be cleared."));
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  // The account menu lives in the site header; a session only exists after hydration, so the slot is in the DOM.
  const accountSlot = session && typeof document !== "undefined" ? document.getElementById("account-menu-slot") : null;
  const banner = demo && <DemoToolbar userId={session?.user.id ?? null} />;
  if (loading) return <>{banner}<p role="status">{t(demo ? "Preparing the demo database…" : "Loading your session…")}</p></>;
  if (sessionError) {
    return <>{banner}<Card title={t("Session unavailable")}><p role="alert">{sessionError}</p><Button onClick={() => window.location.reload()}>{t("Retry session")}</Button></Card></>;
  }
  if (linkToken) {
    return <Card title={t("Confirm sign-in")}>
      <p>{t("Continue to sign in to OpenJury. Email previews do not use your sign-in link.")}</p>
      <Button onClick={confirmLink} disabled={pending}>{t(pending ? "Signing in…" : "Continue to OpenJury")}</Button>
      {pending && <p role="status">{t("Signing in…")}</p>}
    </Card>;
  }
  return (
    <>
      {banner}
      {linkError && <p role="alert">{linkError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {session && client ? (
        <>
          {accountSlot && createPortal(
            <AccountMenu key={session.user.id}
              displayName={typeof session.user.user_metadata.display_name === "string" ? session.user.user_metadata.display_name.trim() : ""}
              email={session.user.email || session.user.id} signingOut={signingOut} onSignOut={signOut} />,
            accountSlot,
          )}
          {signingOut ? <p role="status">{t("Signing out…")}</p> : (
            <AuthContext.Provider value={{ client, session, demo }}>
              <div key={`${session.user.id}:${session.access_token}`} className="space-y-6">{children}</div>
            </AuthContext.Provider>
          )}
        </>
      ) : (
        <>
        {!appMode && signedOut}
        <Card title={t("Sign in to OpenJury")}>
          {!appMode && <p>{t("Sign in with your email to view your groups. New accounts are welcome.")}</p>}
          {demo && <p>{t("In the demo, any email signs in instantly as a new account, or pick a demo person in the toolbar below.")}</p>}
          {!demo && getEnabledSocialProviders().length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {getEnabledSocialProviders().map((provider) => (
                  <Button key={provider.id} disabled={pending} onClick={() => signInWithProvider(provider)}>
                    {t("Sign in with {provider}", { provider: provider.name })}
                  </Button>
                ))}
              </div>
              <p className="text-sm text-slate-600">{t("Use the same verified email to keep one account. If your service uses a different email, sign in to your existing account first and link it in Profile.")}</p>
            </div>
          )}
          <form onSubmit={requestLink} className="space-y-4" aria-busy={pending}>
            <label className="block">{t("Email address")}
              <input ref={emailInput} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} enterKeyHint="send" required disabled={pending} value={email} onChange={(event) => {
                setEmail(event.target.value);
                setCode("");
                // The limit is per address, so a corrected address may be sent at once.
                setCooldown(0);
              }} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button type="submit" disabled={pending || cooldown > 0}>{pending && !oauthProvider && !verifyingCode ? t(appMode ? "Sending code…" : "Sending link…")
              : cooldown > 0 ? t(appMode ? "Send a new code in {seconds} s" : "Send a new link in {seconds} s", { seconds: cooldown })
                : t(appMode ? "Send sign-in code" : "Send sign-in link")}</Button>
          </form>
          {(pending || message) && <p role="status">{pending ? t(oauthProvider ? "Redirecting to sign-in…" : verifyingCode ? "Signing in…" : appMode ? "Sending code…" : "Sending your sign-in link…") : message}</p>}
          {!demo && appMode && <form onSubmit={verifyCode} className="mt-6 space-y-4 border-t border-slate-200 pt-4" aria-busy={verifyingCode}>
            <label className="block">{t("One-time code")}
              <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required disabled={pending} value={code} onChange={(event) => setCode(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button type="submit" disabled={pending || !email.trim() || !code.trim()}>{t(verifyingCode ? "Signing in…" : "Sign in with code")}</Button>
          </form>}
          {passwordSignInEnabled() && (
            <form onSubmit={signInWithPassword} className="mt-6 space-y-4 border-t border-slate-200 pt-4" aria-busy={pending}>
              <p>{t("Preview environment: sign in with the seeded account instead.")}</p>
              <label className="block">{t("Email address")}
                <input type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </label>
              <label className="block">{t("Password")}
                <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
              </label>
              <Button type="submit" disabled={pending}>{t(pending ? "Signing in…" : "Sign in with password")}</Button>
            </form>
          )}
        </Card>
        </>
      )}
    </>
  );
}
