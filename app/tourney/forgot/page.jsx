import {
  RouteTitle,
  Section,
  TourneyPromotionLinks,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { TourneyForgotForm } from "../TourneyPasswordForms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Forgot Password | Roo Industries",
  description: "Reset a Roo Industries account password.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyForgotPage() {
  const session = await getTourneySession();

  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Reset" title="Forgot" accent="Password">
        Use your roster name or email to get a reset link.
      </RouteTitle>
      <TourneyPromotionLinks />

      <div className="tourney-grid">
        <Section id="forgot-password" eyebrow="Reset" title="Request Reset" wide>
          <TourneyForgotForm />
        </Section>
      </div>
    </TourneyShell>
  );
}
