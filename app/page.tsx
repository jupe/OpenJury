import Link from "next/link";
import Card from "@/components/Card";
import AuthBoundary from "@/components/AuthBoundary";

export default function HomePage() {
  return (
    <>
      <p className="text-sm font-semibold uppercase tracking-widest text-indigo-700">Your community. Your jury.</p>
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">Competitions for every community</h1>
      <p className="max-w-2xl text-lg text-slate-600">
        Host baking contests, karaoke nights, or hackathons in your own group,
        with customizable categories and blind voting.
      </p>
      <AuthBoundary>
        <Card title="Welcome to OpenJury">
          <Link href="/dashboard" className="font-medium text-slate-900 underline">
            Explore your dashboard
          </Link>
        </Card>
      </AuthBoundary>
    </>
  );
}
