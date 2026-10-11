import AuthBoundary from "@/components/AuthBoundary";
import { PlatformAdminBoundary } from "@/components/PlatformAdmin";
import { PlatformGroups } from "@/components/Membership";
import { LocalizedText } from "@/lib/i18n";

export default function PlatformGroupsPage() {
  return (
    <AuthBoundary>
      <PlatformAdminBoundary>
        <h1 className="text-3xl font-bold"><LocalizedText message="Groups" /></h1>
        <PlatformGroups />
      </PlatformAdminBoundary>
    </AuthBoundary>
  );
}
