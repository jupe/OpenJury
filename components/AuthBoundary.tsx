"use client";

import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase, passwordSignInEnabled } from "@/lib/supabase";
import Button from "@/components/Button";
import Card from "@/components/Card";
import AccountMenu from "@/components/AccountMenu";
import DemoToolbar from "@/components/DemoToolbar";
import { useLocale } from "@/lib/i18n";

const AuthContext = createContext<{ client: SupabaseClient; session: Session } | null>(null);

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
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const currentSession = useRef<Session | null>(null);
  const confirmingLink = useRef(false);
  const translate = useRef(t);

  useEffect(() => {
    translate.current = t;
  }, [t]);

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
      // Email previews may run JavaScript; only a deliberate click may redeem this token.
      const token = hash.get("token_hash");
      if (token) setLinkToken(token);
      const error = hash.get("error_description") || query.get("error_description") || hash.get("error") || query.get("error");
      if (error) {
        setLinkError(translate.current("Sign-in link failed: {error}. Request a new link below.", { error }));
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
        if (initialized.error) throw initialized.error;
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
    if (!client || pending) return;
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
      if (error) setActionError(t("Unable to send sign-in link: {error}", { error: t(error.message) }));
      else setMessage(t("Check your email for a sign-in link. You can close this tab."));
    } catch {
      if (mounted.current && revision.current === requestRevision) setActionError(t("Unable to send sign-in link. Please try again."));
    } finally {
      if (mounted.current) setPending(false);
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
            <AuthContext.Provider value={{ client, session }}>
              <div key={`${session.user.id}:${session.access_token}`} className="space-y-6">{children}</div>
            </AuthContext.Provider>
          )}
        </>
      ) : (
        <>
        {signedOut}
        <Card title={t("Sign in to OpenJury")}>
          <p>{t("Sign in with your email to view your groups. New accounts are welcome.")}</p>
          {demo && <p>{t("In the demo, any email signs in instantly as a new account, or pick a demo person in the toolbar below.")}</p>}
          <form onSubmit={requestLink} className="space-y-4" aria-busy={pending}>
            <label className="block">{t("Email address")}
              <input type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} enterKeyHint="send" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button type="submit" disabled={pending}>{t(pending ? "Sending link…" : "Send sign-in link")}</Button>
          </form>
          {(pending || message) && <p role="status">{pending ? t("Sending your sign-in link…") : message}</p>}
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
