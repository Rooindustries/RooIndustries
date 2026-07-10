import {
  RouteTitle,
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { TourneyResetForm } from "../TourneyPasswordForms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reset Password | Roo Industries",
  description: "Set a new Roo Industries player password.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyResetPage() {
  const session = await getTourneySession();

  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Reset" title="Set New" accent="Password">
        Use the link from your email to rotate your player password.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="reset-password" eyebrow="Reset" title="New Password" wide>
          <TourneyResetForm />
        </Section>
      </div>
    </TourneyShell>
  );
}
