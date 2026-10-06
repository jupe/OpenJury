import AuthBoundary from "@/components/AuthBoundary";
import { InviteAcceptance, RememberInvite } from "@/components/Membership";
import { LocalizedText } from "@/lib/i18n";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Group invite" /></h1>
      {/* Remembered before sign-in, which returns to the dashboard. */}
      <RememberInvite token={token} />
      <AuthBoundary>
        <InviteAcceptance token={token} />
      </AuthBoundary>
    </>
  );
}
