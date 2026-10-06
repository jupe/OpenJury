import AuthBoundary from "@/components/AuthBoundary";
import { GroupList } from "@/components/Groups";
import { PlatformGroups, ResumePendingInvite } from "@/components/Membership";
import { LocalizedText } from "@/lib/i18n";

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Your groups" /></h1>
      <AuthBoundary>
        <ResumePendingInvite />
        <GroupList />
        <PlatformGroups />
      </AuthBoundary>
    </>
  );
}
