import { redirect } from "next/navigation";
import {
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { canAccessTourneyRegistration } from "../../../src/server/tourney/access";
import {
  getTourneyRegistrationCloseIso,
  isTourneyRegistrationClosed,
} from "../../../src/server/tourney/playerStore";
import TourneyRegistrationForm from "../TourneyRegistrationForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creator Registration | Roo Industries",
  description: "Private creator Roo Industries tournament registration page.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyRegisterPage() {
  const session = await getTourneySession();
  const registrationClosed = isTourneyRegistrationClosed();
  const registrationClosesAt = getTourneyRegistrationCloseIso();

  if (!canAccessTourneyRegistration(session)) {
    redirect("/tourney");
  }

  return (
    <TourneyShell session={session} activeHref="/tourney/register">
      <RouteTitle title="Creator" accent="Registration">
        Submit your player info once. This Overwatch tournament is for creators,
        and owner/caster admins use your Twitch username during review before
        accounts go live.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="registration-form" eyebrow="Register" title="Creator Signup" wide>
          <TourneyRegistrationForm
            registrationClosed={registrationClosed}
            registrationClosesAt={registrationClosesAt}
          />
        </Section>
      </div>
    </TourneyShell>
  );
}
