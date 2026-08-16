import { notFound } from "next/navigation";
import { isTourneyFeedbackSlugValid } from "../../../../src/server/tourney/feedbackAccess";
import {
  RouteTitle,
  Section,
  TourneyShell,
} from "../../TourneyShared";
import TourneyFeedbackPanel from "../../TourneyFeedbackPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tournament Feedback | Roo Industries",
  description: "Anonymous Roo Industries Tourney participant feedback form.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyFeedbackPage({ params }) {
  const { slug } = await params;
  if (!isTourneyFeedbackSlugValid({ slug })) notFound();

  const isPreviewMode =
    process.env.VERCEL_ENV === "preview" &&
    process.env.TOURNEY_FEEDBACK_PREVIEW_MODE === "1";

  return (
    <TourneyShell>
      <div className="tourney-feedback-route">
        <RouteTitle eyebrow="Participant Feedback" title="Make The Next" accent="Tourney Better">
          This anonymous form is only for players who took part in the Roo
          Industries Tourney. No account or sign-in is required.
        </RouteTitle>

        <div className="tourney-grid">
          <Section id="feedback" eyebrow="Participants Only" title="Your Feedback" wide>
            <TourneyFeedbackPanel
              feedbackSlug={slug}
              previewMode={isPreviewMode}
            />
          </Section>
        </div>
      </div>
    </TourneyShell>
  );
}
