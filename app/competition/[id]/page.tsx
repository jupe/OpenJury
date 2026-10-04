import Link from "next/link";
import Button from "@/components/Button";
import Card from "@/components/Card";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Competition</h1>
      <p className="break-all text-slate-600">Competition: {id}</p>
      <Card title="Submissions and voting">
        <p>Entry submissions, anonymous voting cards, and published results will appear here.</p>
        <div className="flex flex-wrap gap-3">
          <Button disabled>Submit entry (coming soon)</Button>
          <Button disabled>Vote (coming soon)</Button>
        </div>
        <Link href={`/competition/${encodeURIComponent(id)}/admin`} className="inline-block underline">
          Preview admin view
        </Link>
      </Card>
    </>
  );
}
