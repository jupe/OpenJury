import AuthBoundary from "@/components/AuthBoundary";
import { GroupList } from "@/components/Groups";
import { PlatformGroups, ResumePendingInvite } from "@/components/Membership";

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your groups</h1>
      <AuthBoundary>
        <ResumePendingInvite />
        <GroupList />
        <PlatformGroups />
      </AuthBoundary>
    </>
  );
}
