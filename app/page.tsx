import Link from "next/link";
import Card from "@/components/Card";
import AuthBoundary from "@/components/AuthBoundary";

export default function HomePage() {
  return (
    <>
      <h1 className="text-4xl font-bold">Competitions for every community</h1>
      <p className="text-lg text-slate-600">
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
