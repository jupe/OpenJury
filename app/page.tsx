import AuthBoundary from "@/components/AuthBoundary";
import { HomeOverview } from "@/components/Home";
import { LocalizedText } from "@/lib/i18n";

export default function HomePage() {
  return (
    <AuthBoundary
      signedOut={
        <div className="space-y-6">
        <section className="landing-hero space-y-5">
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl"><LocalizedText message="Competitions for every community" /></h1>
          <p className="max-w-2xl text-lg text-slate-600">
            <LocalizedText message="Host baking contests, karaoke nights, or hackathons in your own group, with customizable categories and blind voting." />
          </p>
        </section>
        <section aria-labelledby="home-screen-guide" className="app-card space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
          <h2 id="home-screen-guide" className="text-xl font-semibold"><LocalizedText message="Add OpenJury to your Home Screen" /></h2>
          <p><LocalizedText message="Install OpenJury for an app-like experience. No app store download is needed." /></p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <h3 className="font-semibold">iPhone / iPad</h3>
              <ol className="list-decimal space-y-2 pl-5">
                <li><LocalizedText message="Open this site in Safari." /></li>
                <li><LocalizedText message="Tap Share (the square with an upward arrow), then Add to Home Screen. You may need to scroll down." /></li>
                <li><LocalizedText message="Keep Open as Web App enabled if shown, then tap Add." /></li>
                <li><LocalizedText message="Open OpenJury from your Home Screen and sign in. Use the sign-in code from your email inside the app." /></li>
              </ol>
            </div>
            <div className="space-y-3">
              <h3 className="font-semibold">Android</h3>
              <ol className="list-decimal space-y-2 pl-5">
                <li><LocalizedText message="Open this site in Chrome." /></li>
                <li><LocalizedText message="Tap the three-dot menu (⋮), then Add to Home screen or Install app." /></li>
                <li><LocalizedText message="Choose Install if offered, then confirm Install or Add." /></li>
                <li><LocalizedText message="Open OpenJury from your Home Screen and sign in. Use the sign-in code from your email inside the app." /></li>
              </ol>
            </div>
          </div>
          <p><LocalizedText message="For notifications, open Profile → Enable notifications, then choose Allow notifications. iPhone and iPad require iOS/iPadOS 16.4 or later; Android requires a supported browser such as Chrome. Notifications require HTTPS and are unavailable in the demo." /></p>
        </section>
        </div>
      }
    >
      <HomeOverview />
    </AuthBoundary>
  );
}
