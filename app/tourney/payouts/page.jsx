import {
  LockScreen,
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyPayoutsPanel from "../TourneyPayoutsPanel";
import { listTourneyPayoutsForSession } from "../../../src/server/tourney/appealPayoutStore";
import { listManageTourneyPlayers } from "../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Payouts | Roo Industries",
  description: "Hidden Roo Industries payout dashboard.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyPayoutsPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();

  if (!session) {
    return (
      <LockScreen
        error={resolvedSearchParams?.error || ""}
        heading="Sign in."
        subtitle="Payouts require a Roo Industries account."
        note="Use your approved player, caster, or owner account."
        buttonLabel="Sign in"
        redirectTo="/tourney/payouts"
      />
    );
  }

  const isAdmin = session.role === "owner" || session.role === "caster";
  const [payouts, players] = await Promise.all([
    listTourneyPayoutsForSession({ session }).catch(() => []),
    isAdmin ? listManageTourneyPlayers().catch(() => []) : [],
  ]);

  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Payouts" title="Player" accent="Payouts">
        Payouts are tracked per player for placements, MVPs, website proceeds,
        and manual adjustments.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="payouts" eyebrow="Hidden" title="Payouts" wide>
          <TourneyPayoutsPanel
            initialPayouts={payouts}
            players={players}
            currentRole={session.role}
          />
        </Section>
      </div>
    </TourneyShell>
  );
}
