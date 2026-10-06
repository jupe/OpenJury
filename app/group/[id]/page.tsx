import AuthBoundary from "@/components/AuthBoundary";
import { GroupDetails } from "@/components/Groups";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <AuthBoundary><GroupDetails key={id} id={id} /></AuthBoundary>;
}
