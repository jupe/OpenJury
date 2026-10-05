import AuthBoundary from "@/components/AuthBoundary";
import { EntryWorkspace } from "@/components/EntryWorkspace";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Competition</h1>
      <AuthBoundary>
        <EntryWorkspace competitionId={id} />
      </AuthBoundary>
    </>
  );
}
