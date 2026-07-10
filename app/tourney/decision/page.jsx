import { RouteTitle, Section, TourneyShell, getTourneySession } from "../TourneyShared";
import TourneyDecisionPanel from "../TourneyDecisionPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Registration Decision | Roo Industries",
  robots: { index: false, follow: false, nocache: true },
};

export default async function TourneyDecisionPage() {
  const session = await getTourneySession();
  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Registration" title="Review" accent="Decision">
        Confirming the secure approval link from your email.
      </RouteTitle>
      <div className="tourney-grid">
        <Section id="registration-decision" eyebrow="Registration" title="Decision" wide>
          <TourneyDecisionPanel />
        </Section>
      </div>
    </TourneyShell>
  );
}
