import { notFound } from "next/navigation";
import {
  LockScreen,
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import OwnerAccountManager from "../OwnerAccountManager";
import TourneyBracketManager from "../TourneyBracketManager";
import TourneyPlayerManager from "../TourneyPlayerManager";
import {
  readEffectiveTourneyAccounts,
  summarizeTourneyAccounts,
} from "../../../src/server/tourney/auth";
import { getTourneyBracketSnapshot } from "../../../src/server/tourney/bracketStore";
import {
  getTourneyRoleCapacitySnapshot,
  listManageTourneyPlayers,
} from "../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Manage | Roo Industries Tourney",
  description: "Tournament registration and account management.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyManagePage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();

  if (!session) {
    return (
      <LockScreen
        error={resolvedSearchParams?.error || ""}
        heading="Sign in."
        subtitle="Manage access requires an owner or caster account."
        note="Use your assigned tourney admin account."
        buttonLabel="Sign in"
        redirectTo="/tourney/manage"
      />
    );
  }

  if (!["owner", "caster"].includes(session.role)) {
    notFound();
  }

  const accounts =
    session.role === "owner"
      ? summarizeTourneyAccounts(await readEffectiveTourneyAccounts())
      : [];
  const [players, capacitySnapshot, bracketSnapshot] = await Promise.all([
    listManageTourneyPlayers().catch(() => []),
    getTourneyRoleCapacitySnapshot().catch(() => ({
      teamCount: 8,
      roles: [],
    })),
    getTourneyBracketSnapshot({ includeAudit: true }).catch(() => ({
      ok: true,
      meta: {},
      teams: [],
      matches: [],
      groups: [],
      generated: false,
      audit: [],
    })),
  ]);

  return (
    <TourneyShell session={session} activeHref="/tourney/manage">
      <RouteTitle eyebrow="Manage" title="Tournament" accent="Control">
        Review registrations, add approved players, and remove players when
        needed.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="players" eyebrow="Players" title="Player Management" wide>
          <TourneyPlayerManager
            initialPlayers={players}
            initialCapacity={capacitySnapshot}
          />
        </Section>

        {session.role === "owner" ? (
          <Section id="manage" eyebrow="Owner" title="Account Management" wide>
            <OwnerAccountManager
              initialAccounts={accounts}
              currentUsername={session.username}
            />
          </Section>
        ) : null}

        <Section id="bracket" eyebrow="Bracket" title="Bracket Control" wide>
          <TourneyBracketManager
            initialSnapshot={bracketSnapshot}
            currentRole={session.role}
          />
        </Section>
      </div>
    </TourneyShell>
  );
}
