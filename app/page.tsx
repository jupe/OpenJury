import Link from "next/link";
import Card from "@/components/Card";
import AuthBoundary from "@/components/AuthBoundary";
import { LocalizedText } from "@/lib/i18n";

export default function HomePage() {
  return (
    <>
      <p className="text-sm font-semibold uppercase tracking-widest text-indigo-700"><LocalizedText message="Your community. Your jury." /></p>
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl"><LocalizedText message="Competitions for every community" /></h1>
      <p className="max-w-2xl text-lg text-slate-600">
        <LocalizedText message="Host baking contests, karaoke nights, or hackathons in your own group, with customizable categories and blind voting." />
      </p>
      <AuthBoundary>
        <Card title={<LocalizedText message="Welcome to OpenJury" />}>
          <Link href="/dashboard" className="font-medium text-slate-900 underline">
            <LocalizedText message="Explore your dashboard" />
          </Link>
        </Card>
      </AuthBoundary>
    </>
  );
}
