import AuthBoundary from "@/components/AuthBoundary";
import ActiveCompetitionRedirect from "@/components/ActiveCompetitionRedirect";

export default function CompetitionsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Competitions</h1>
      <AuthBoundary>
        <ActiveCompetitionRedirect />
      </AuthBoundary>
    </>
  );
}
