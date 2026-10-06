import AuthBoundary from "@/components/AuthBoundary";
import { GroupDetails } from "@/components/Groups";
import { LocalizedText } from "@/lib/i18n";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Group lobby" /></h1>
      <AuthBoundary>
        <GroupDetails key={id} id={id} />
      </AuthBoundary>
    </>
  );
}
