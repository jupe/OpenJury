import AuthBoundary from "@/components/AuthBoundary";
import ActiveCompetitionRedirect from "@/components/ActiveCompetitionRedirect";
import { LocalizedText } from "@/lib/i18n";

export default function CompetitionsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold"><LocalizedText message="Competitions" /></h1>
      <AuthBoundary>
        <ActiveCompetitionRedirect />
      </AuthBoundary>
    </>
  );
}
