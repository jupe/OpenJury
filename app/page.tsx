import AuthBoundary from "@/components/AuthBoundary";
import { HomeOverview } from "@/components/Home";
import { LocalizedText } from "@/lib/i18n";

export default function HomePage() {
  return (
    <AuthBoundary
      signedOut={
        <section className="landing-hero space-y-5">
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl"><LocalizedText message="Competitions for every community" /></h1>
          <p className="max-w-2xl text-lg text-slate-600">
            <LocalizedText message="Host baking contests, karaoke nights, or hackathons in your own group, with customizable categories and blind voting." />
          </p>
        </section>
      }
    >
      <HomeOverview />
    </AuthBoundary>
  );
}
