import Link from "next/link";
import Button from "@/components/Button";
import Card from "@/components/Card";

const demoCompetition = "/competition/demo";
const demoGroup = "/group/demo";

export function DemoHome() {
  return (
    <Card title="Explore the demo">
      <p>Browse the main OpenJury views with fictional sample content. Nothing is saved.</p>
      <div className="flex flex-wrap gap-4">
        <Link className="underline" href="/dashboard">Dashboard</Link>
        <Link className="underline" href={demoGroup}>Group lobby</Link>
        <Link className="underline" href={demoCompetition}>Participant view</Link>
        <Link className="underline" href={`${demoCompetition}/admin`}>Admin review</Link>
      </div>
    </Card>
  );
}

export function DemoDashboard() {
  return (
    <>
      <Card title="Your memberships">
        <ul className="space-y-3">
          <li>
            <Link className="font-semibold underline" href={demoGroup}>Northside Makers</Link>
            <p className="text-sm">1 demo competition · Demo admin</p>
          </li>
        </ul>
      </Card>
      <Card title="Build your community">
        <p>Group creation is available after connecting Supabase. In demo mode, explore the sample group instead.</p>
        <Link className="underline" href={demoGroup}>Open Northside Makers</Link>
      </Card>
    </>
  );
}

export function DemoGroup({ id }: { id: string }) {
  return (
    <>
      <Card title={id === "demo" ? "Northside Makers" : "Demo group"}>
        <p>Sample community for previewing group and competition views.</p>
        <p className="text-sm">Your role: Admin · Members: 12</p>
      </Card>
      <Card title="Competitions">
        <ul className="space-y-4">
          <li className="rounded-xl border border-slate-200 p-4">
            <Link className="font-semibold underline" href={demoCompetition}>Spring Bake-off</Link>
            <p className="text-sm">Remote · Voting</p>
            <p className="text-sm">Submissions close May 20 · Voting closes May 27</p>
            <div className="mt-3 flex flex-wrap gap-4">
              <Link className="underline" href={demoCompetition}>Participant view</Link>
              <Link className="underline" href={`${demoCompetition}/admin`}>Admin review</Link>
            </div>
          </li>
          <li className="rounded-xl border border-slate-200 p-4">
            <span className="font-semibold">Community Chili Cook-off</span>
            <p className="text-sm">Live · Draft</p>
            <p className="text-sm">A second sample showing a competition before submissions open.</p>
          </li>
        </ul>
      </Card>
    </>
  );
}

export function DemoCompetition({ id }: { id: string }) {
  return (
    <>
      <Card title="Spring Bake-off">
        <p>Remote · Example views for submission, voting, and published results.</p>
        <p>Scoring categories: Presentation, Creativity, and Taste.</p>
        <div className="flex flex-wrap gap-4">
          <Link className="underline" href={demoGroup}>Back to Northside Makers</Link>
          <Link className="underline" href={`/competition/${encodeURIComponent(id)}/admin`}>Admin review</Link>
        </div>
        <nav aria-label="Demo competition sections" className="flex flex-wrap gap-4">
          <a className="underline" href="#submission">Submission example</a>
          <a className="underline" href="#voting">Voting example</a>
          <a className="underline" href="#results">Published results example</a>
        </nav>
      </Card>

      <Card title="Submission view example">
        <section id="submission" className="space-y-3">
          <p>Sample entry by you. In a real competition, members can edit this before submissions close.</p>
          <label className="block">Entry title
            <input disabled value="Lemon cloud tart" readOnly className="mt-1 block w-full rounded border border-slate-300 p-2" />
          </label>
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
            Sample entry image preview
          </p>
          <Button disabled>Save submission</Button>
        </section>
      </Card>

      <Card title="Anonymous voting view example">
        <section id="voting" className="space-y-4">
          <p>Fictional entries are identified by number. A real ballot is private and can be revised before voting closes.</p>
          {[12, 27].map((number) => (
            <div key={number} className="rounded-xl border border-slate-200 p-4">
              <h3 className="font-semibold">Entry {number}</h3>
              <p className="my-2 rounded-xl border border-dashed border-slate-300 p-5 text-center">
                Anonymous sample image
              </p>
              {["Presentation", "Creativity", "Taste"].map((category) => (
                <label key={category} className="mb-3 block">{category}
                  <select disabled defaultValue="4" className="mt-1 block w-full rounded border border-slate-300 p-2">
                    {[1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score}</option>)}
                  </select>
                </label>
              ))}
              <Button disabled>Save ballot</Button>
            </div>
          ))}
        </section>
      </Card>

      <Card title="Published results view example">
        <ol id="results" className="space-y-3">
          <li className="rounded-xl border border-slate-200 p-3">
            <h3 className="font-semibold">Rank 1: Lemon cloud tart</h3>
            <p>Submitted by Sample member · 92.40% · 8 complete ballots</p>
          </li>
          <li className="rounded-xl border border-slate-200 p-3">
            <h3 className="font-semibold">Rank 2: Berry garden cake</h3>
            <p>Submitted by Sample member · 88.10% · 8 complete ballots</p>
          </li>
        </ol>
        <p>These fictional results illustrate the published member view.</p>
      </Card>
    </>
  );
}

export function DemoAdmin({ id }: { id: string }) {
  return (
    <>
      <Card title="Spring Bake-off · Admin">
        <p>Example admin views: submission review, preliminary rankings, and publication.</p>
        <div className="flex flex-wrap gap-4">
          <Link className="underline" href={`/competition/${encodeURIComponent(id)}`}>Participant view</Link>
          <Link className="underline" href={demoGroup}>Back to Northside Makers</Link>
        </div>
      </Card>

      <Card title="Competition attendees">
        <p>Fictional group members, including those who have not submitted an entry.</p>
        <ul className="space-y-3">
          <li><p className="font-semibold">Sample admin</p><p>Admin · No submission · Has voted</p></li>
          <li><p className="font-semibold">Sample member A</p><p>Member · Submitted · Has voted</p></li>
          <li><p className="font-semibold">Sample member B</p><p>Member · Submitted · Has not voted</p></li>
          <li><p className="font-semibold">Sample member C</p><p>Member · No submission · Has not voted</p></li>
        </ul>
      </Card>

      <Card title="Private submission review example">
        <ul className="space-y-4">
          {[
            ["Lemon cloud tart", "Sample member A"],
            ["Berry garden cake", "Sample member B"],
          ].map(([title, creator]) => (
            <li key={title} className="rounded-xl border border-slate-200 p-4">
              <h3 className="font-semibold">{title}</h3>
              <p>Submitted by {creator}</p>
              <p className="my-2 rounded-xl border border-dashed border-slate-300 p-5 text-center">
                Sample submission image
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Preliminary rankings example">
        <p>Illustrative category-normalized averages from complete ballots; admins can disqualify entries before publication.</p>
        <ol className="space-y-3">
          <li className="rounded-xl border border-slate-200 p-3">
            <h3 className="font-semibold">Rank 1: Lemon cloud tart</h3>
            <p>Sample member A · 92.40% · 8 complete ballots</p>
            <label className="mt-3 block">Disqualification reason
              <input disabled placeholder="Available to authorized admins" className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button disabled className="mt-3">Disqualify</Button>
          </li>
          <li className="rounded-xl border border-slate-200 p-3">
            <h3 className="font-semibold">Rank 2: Berry garden cake</h3>
            <p>Sample member B · 88.10% · 8 complete ballots</p>
          </li>
        </ol>
        <Button disabled>Publish final results</Button>
      </Card>
    </>
  );
}
