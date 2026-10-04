import Button from "@/components/Button";
import Card from "@/components/Card";

export default async function CompetitionAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <h1 className="text-3xl font-bold">Competition admin</h1>
      <p className="break-all text-slate-600">Competition: {id}</p>
      <Card title="Review and publish">
        <p>This public placeholder contains no private data. Admin authorization is not implemented yet.</p>
        <p>Category setup, state controls, moderation, and preliminary results will appear here.</p>
        <div className="flex flex-wrap gap-3">
          <Button disabled>Start voting (coming soon)</Button>
          <Button disabled>Stop voting (coming soon)</Button>
          <Button disabled>Publish results (coming soon)</Button>
        </div>
      </Card>
    </>
  );
}
