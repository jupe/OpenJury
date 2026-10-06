import AuthBoundary from "@/components/AuthBoundary";
import { AdminSubmissions } from "@/components/EntryWorkspace";
import { LocalizedText } from "@/lib/i18n";

export default async function CompetitionAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Competition admin" /></h1>
      <AuthBoundary>
        <AdminSubmissions key={id} competitionId={id} />
      </AuthBoundary>
    </>
  );
}
