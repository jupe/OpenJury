import AuthBoundary from "@/components/AuthBoundary";
import { ProfileSettings } from "@/components/Profile";
import { LocalizedText } from "@/lib/i18n";

export default function ProfilePage() {
  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Profile" /></h1>
      <AuthBoundary>
        <ProfileSettings />
      </AuthBoundary>
    </>
  );
}
