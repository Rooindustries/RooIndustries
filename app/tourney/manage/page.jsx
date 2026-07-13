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
import { readAdminTourneyPlayers } from "../../../src/server/tourney/readService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Manage | Roo Industries",
  description: "Roo Industries registration and account management.",
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
        note="Use your assigned Roo Industries admin account."
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
  const [adminPlayers, bracketSnapshot] = await Promise.all([
    readAdminTourneyPlayers().catch(() => ({
      ok: false,
      players: [],
      capacity: { teamCount: 8, roles: [] },
    })),
    getTourneyBracketSnapshot({ includeAudit: true }).catch(() => ({
      ok: false,
      meta: {},
      teams: [],
      matches: [],
      groups: [],
      generated: false,
      audit: [],
    })),
  ]);
  const players = adminPlayers.players;
  const capacitySnapshot = adminPlayers.capacity;

  return (
    <TourneyShell session={session} activeHref="/tourney/manage">
      <RouteTitle eyebrow="Manage" title="Tournament" accent="Control">
        Review registrations, add approved players, and remove players when
        needed.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="players" eyebrow="Players" title="Player Management" wide>
          {!adminPlayers.ok ? (
            <p className="cs-error" role="alert">
              Player data is temporarily unavailable. Do not make roster decisions
              until this warning clears.
            </p>
          ) : null}
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
          {!bracketSnapshot.ok ? (
            <p className="cs-error" role="alert">
              Bracket data is temporarily unavailable. Do not publish or edit the
              bracket until this warning clears.
            </p>
          ) : null}
          <TourneyBracketManager
            initialSnapshot={bracketSnapshot}
            currentRole={session.role}
          />
        </Section>
      </div>
    </TourneyShell>
  );
}
