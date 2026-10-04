import AuthBoundary from "@/components/AuthBoundary";
import { EntryWorkspace } from "@/components/EntryWorkspace";
import { DemoCompetition } from "@/components/DemoViews";

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
      <AuthBoundary demo={<DemoCompetition id={id} />}>
        <EntryWorkspace competitionId={id} />
      </AuthBoundary>
    </>
  );
}
