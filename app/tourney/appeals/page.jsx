import {
  LockScreen,
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyAppealsPanel from "../TourneyAppealsPanel";
import { listTourneyAppealsForSession } from "../../../src/server/tourney/appealPayoutStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Appeals | Roo Industries",
  description: "Hidden Roo Industries appeals dashboard.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyAppealsPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();

  if (!session) {
    return (
      <LockScreen
        error={resolvedSearchParams?.error || ""}
        heading="Sign in."
        subtitle="Appeals require a Roo Industries account."
        note="Use your approved player, caster, or owner account."
        buttonLabel="Sign in"
        redirectTo="/tourney/appeals"
      />
    );
  }

  const appeals = await listTourneyAppealsForSession({ session }).catch(() => []);

  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Appeals" title="Appeal" accent="System">
        Captains can appeal for their team. Players can file a complaint against
        a captain.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="appeals" eyebrow="Hidden" title="Appeals" wide>
          <TourneyAppealsPanel
            initialAppeals={appeals}
            currentRole={session.role}
          />
        </Section>
      </div>
    </TourneyShell>
  );
}
