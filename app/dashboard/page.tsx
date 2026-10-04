import Link from "next/link";
import Button from "@/components/Button";
import Card from "@/components/Card";

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your groups</h1>
      <Card title="Build your community">
        <p>Your groups will appear here after authentication is connected.</p>
        <Button disabled>Create group (coming soon)</Button>
        <p>
          <Link href="/group/demo" className="underline">Preview a group</Link>
        </p>
      </Card>
    </>
  );
}
