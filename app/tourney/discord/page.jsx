import { RouteTitle, Section, TourneyShell, getTourneySession } from "../TourneyShared";
import TourneyDiscordPanel from "../TourneyDiscordPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Discord Verification | Roo Industries",
  robots: { index: false, follow: false, nocache: true },
};

export default async function TourneyDiscordPage() {
  const session = await getTourneySession();
  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Discord" title="Verify" accent="Access">
        Connecting your approved tournament registration to Discord.
      </RouteTitle>
      <div className="tourney-grid">
        <Section id="discord-verification" eyebrow="Discord" title="Verification" wide>
          <TourneyDiscordPanel />
        </Section>
      </div>
    </TourneyShell>
  );
}
