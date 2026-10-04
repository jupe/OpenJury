import Link from "next/link";
import Card from "@/components/Card";
import AuthBoundary from "@/components/AuthBoundary";
import { GroupList } from "@/components/Groups";

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your groups</h1>
      <AuthBoundary demo={
        <Card title="Build your community">
          <p>Configure Supabase to sign in and create groups.</p>
          <Link href="/group/demo" className="underline">Preview a group</Link>
        </Card>
      }>
        <GroupList />
      </AuthBoundary>
    </>
  );
}
