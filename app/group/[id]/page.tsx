import Link from "next/link";
import Card from "@/components/Card";
import AuthBoundary from "@/components/AuthBoundary";
import { GroupDetails } from "@/components/Groups";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Group lobby</h1>
      <AuthBoundary demo={
        <Card title="Demo group">
          <p className="break-all">Group: {id}</p>
          <p>Group competitions are not available yet. This is a public preview.</p>
          <Link href="/competition/demo" className="underline">Preview a competition</Link>
        </Card>
      }>
        <GroupDetails key={id} id={id} />
      </AuthBoundary>
    </>
  );
}
