import { notFound } from "next/navigation";
import {
  LockScreen,
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyBracketManager from "../TourneyBracketManager";
import TourneyControlRecovery from "./TourneyControlRecovery";
import { canManageTourneyMatch } from "../../../src/server/tourney/access";
import { readTourneyBroadcastMedia } from "../../../src/server/tourney/broadcastMedia";
import { createTourneyBroadcastOverlayToken } from "../../../src/server/tourney/broadcastOverlayToken";
import { getTourneyBracketSnapshot } from "../../../src/server/tourney/bracketStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Match Control | Roo Industries",
  description: "Live tournament match scoring and bracket control.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyControlPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();

  if (!session) {
    return (
      <LockScreen
        error={resolvedSearchParams?.error || ""}
        heading="Sign in."
        subtitle="Match control requires an owner or caster account."
        note="Use your assigned Roo Industries admin account."
        buttonLabel="Sign in"
        redirectTo="/tourney/control"
      />
    );
  }

  if (!["owner", "caster"].includes(session.role)) {
    notFound();
  }

  const [bracketSnapshot, broadcastMedia] = await Promise.all([
    getTourneyBracketSnapshot({
      includeAudit: true,
    }).catch(() => ({
      ok: false,
      meta: {},
      teams: [],
      matches: [],
      groups: [],
      generated: false,
      audit: [],
    })),
    readTourneyBroadcastMedia().catch(() => ({ heroes: [], maps: [] })),
  ]);
  const broadcastSourcePaths = Object.fromEntries(
    (bracketSnapshot.matches || [])
      .filter((match) => canManageTourneyMatch({ session, match }))
      .map((match) => {
        const token = createTourneyBroadcastOverlayToken({ matchId: match.id });
        return [
          match.id,
          `/tourney/overlay/caster?token=${encodeURIComponent(token)}`,
        ];
      })
  );

  return (
    <TourneyShell
      session={session}
      activeHref="/tourney/control"
      wide
      performanceMode
    >
      <RouteTitle eyebrow="Tournament operations" title="Match" accent="Control">
        Score matches, advance winners, handle forfeits or disqualifications, and
        safely reopen completed results from one focused desk.
      </RouteTitle>

      <Section id="match-control" eyebrow="Live desk" title="Bracket Operations" wide>
        {!bracketSnapshot.ok ? (
          <TourneyControlRecovery />
        ) : (
          <TourneyBracketManager
            initialSnapshot={bracketSnapshot}
            currentRole={session.role}
            currentUsername={session.username}
            broadcastMedia={broadcastMedia}
            broadcastSourcePaths={broadcastSourcePaths}
            operationsOnly
          />
        )}
      </Section>
    </TourneyShell>
  );
}
