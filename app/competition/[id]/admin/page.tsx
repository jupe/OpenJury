import AuthBoundary from "@/components/AuthBoundary";
import { AdminSubmissions } from "@/components/EntryWorkspace";
import { DemoAdmin } from "@/components/DemoViews";

export default async function CompetitionAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Competition admin</h1>
      <p className="break-all text-slate-600">Competition: {id}</p>
      <AuthBoundary demo={<DemoAdmin id={id} />}>
        <AdminSubmissions competitionId={id} />
      </AuthBoundary>
    </>
  );
}
