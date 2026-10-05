import AuthBoundary from "@/components/AuthBoundary";
import { GroupList } from "@/components/Groups";
import { PlatformGroups, ResumePendingInvite } from "@/components/Membership";
import { DemoDashboard } from "@/components/DemoViews";

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your groups</h1>
      <AuthBoundary demo={<DemoDashboard />}>
        <ResumePendingInvite />
        <GroupList />
        <PlatformGroups />
      </AuthBoundary>
    </>
  );
}
