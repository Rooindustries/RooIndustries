import { notFound } from "next/navigation";
import {
  LockScreen,
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import OwnerAccountManager from "../OwnerAccountManager";
import TourneyPlayerManager from "../TourneyPlayerManager";
import {
  readEffectiveTourneyAccounts,
  summarizeTourneyAccounts,
} from "../../../src/server/tourney/auth";
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
        subtitle="Manage access requires the tournament owner account."
        note="Use your assigned Roo Industries admin account."
        buttonLabel="Sign in"
        redirectTo="/tourney/manage"
      />
    );
  }

  if (session.role !== "owner") {
    notFound();
  }

  const accounts = summarizeTourneyAccounts(
    await readEffectiveTourneyAccounts()
  );
  const adminPlayers = await readAdminTourneyPlayers().catch(() => ({
    ok: false,
    players: [],
    capacity: { teamCount: 12, roles: [] },
  }));
  const players = adminPlayers.players;
  const capacitySnapshot = adminPlayers.capacity;

  return (
    <TourneyShell
      session={session}
      activeHref="/tourney/manage"
      performanceMode
      showPromotionLinks={false}
    >
      <RouteTitle eyebrow="Manage" title="Tournament" accent="Control">
        Review registrations, add approved players, and remove players when
        needed.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="players" eyebrow="Players" title="Player Management" wide>
          {!adminPlayers.ok ? (
            <p className="cs-error" role="alert">
              Player data is temporarily unavailable. Roster controls are disabled
              until this warning clears.
            </p>
          ) : (
            <TourneyPlayerManager
              initialPlayers={players}
              initialCapacity={capacitySnapshot}
            />
          )}
        </Section>

        <Section id="manage" eyebrow="Owner" title="Account Management" wide>
          <OwnerAccountManager
            initialAccounts={accounts}
            currentUsername={session.username}
          />
        </Section>

        <Section id="overlays" eyebrow="Stream" title="Stream Overlays" wide>
          <p>
            OBS browser sources for the live bracket and the current-match
            strip are available with copy-ready URLs and setup notes.
          </p>
          <p>
            <a className="tourney-owner-link" href="/tourney/overlay">
              Open stream overlays
            </a>
          </p>
        </Section>
      </div>
    </TourneyShell>
  );
}
