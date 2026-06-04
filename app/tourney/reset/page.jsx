import {
  RouteTitle,
  Section,
  StatusPanel,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { TourneyResetForm } from "../TourneyPasswordForms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reset Password | Roo Industries Tourney",
  description: "Set a new Roo Industries tournament player password.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyResetPage({ searchParams }) {
  const session = await getTourneySession();
  const resolvedSearchParams = await searchParams;
  const token = String(resolvedSearchParams?.token || "");

  return (
    <TourneyShell session={session}>
      <RouteTitle eyebrow="Reset" title="Set New" accent="Password">
        Use the link from your email to rotate your player password.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="reset-password" eyebrow="Reset" title="New Password" wide>
          {token ? (
            <TourneyResetForm token={token} />
          ) : (
            <StatusPanel label="Missing" title="Reset token missing">
              Request a new password reset link before setting a new password.
            </StatusPanel>
          )}
        </Section>
      </div>
    </TourneyShell>
  );
}
