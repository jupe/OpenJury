import Link from "next/link";
import Card from "@/components/Card";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Group lobby</h1>
      <p className="break-all text-slate-600">Group: {id}</p>
      <Card title="Competitions">
        <p>Active and past competitions for this group will appear here.</p>
        <Link href="/competition/demo" className="underline">Preview a competition</Link>
      </Card>
    </>
  );
}
