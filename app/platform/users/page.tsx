import AuthBoundary from "@/components/AuthBoundary";
import { PlatformAdminBoundary } from "@/components/PlatformAdmin";
import PlatformUsers from "@/components/PlatformUsers";
import { LocalizedText } from "@/lib/i18n";

export default function PlatformUsersPage() {
  return (
    <AuthBoundary>
      <PlatformAdminBoundary>
        <h1 className="text-3xl font-bold"><LocalizedText message="Users" /></h1>
        <PlatformUsers />
      </PlatformAdminBoundary>
    </AuthBoundary>
  );
}
