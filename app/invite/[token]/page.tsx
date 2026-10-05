import AuthBoundary from "@/components/AuthBoundary";
import { InviteAcceptance, RememberInvite } from "@/components/Membership";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Group invite</h1>
      {/* Remembered before sign-in, which returns to the dashboard. */}
      <RememberInvite token={token} />
      <AuthBoundary>
        <InviteAcceptance token={token} />
      </AuthBoundary>
    </>
  );
}
