import Link from "next/link";
import Button from "@/components/Button";
import Card from "@/components/Card";

export default function HomePage() {
  return (
    <>
      <h1 className="text-4xl font-bold">Competitions for every community</h1>
      <p className="text-lg text-slate-600">
        Host baking contests, karaoke nights, or hackathons in your own group,
        with customizable categories and blind voting.
      </p>
      <Card title="Welcome to OpenJury">
        <p>This starter previews the platform. Authentication is not connected yet.</p>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/dashboard" className="font-medium text-slate-900 underline">
            Explore your dashboard
          </Link>
          <Button disabled>Sign in (coming soon)</Button>
        </div>
      </Card>
    </>
  );
}
