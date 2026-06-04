import { redirect } from "next/navigation";
import {
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { canAccessTourneyRegistration } from "../../../src/server/tourney/access";
import TourneyRegistrationForm from "../TourneyRegistrationForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Register | Roo Industries Tourney",
  description: "Private tournament registration page.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyRegisterPage() {
  const session = await getTourneySession();

  if (!canAccessTourneyRegistration(session)) {
    redirect("/tourney");
  }

  return (
    <TourneyShell session={session} activeHref="/tourney/register">
      <RouteTitle title="Tournament" accent="Registration">
        Submit your player info once. Owner and caster admins review signups
        before accounts go live.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="registration-form" eyebrow="Register" title="Player Signup" wide>
          <TourneyRegistrationForm />
        </Section>
      </div>
    </TourneyShell>
  );
}
