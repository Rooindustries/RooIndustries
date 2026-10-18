import MeetTheTeam from "@/src/next/entries/MeetTheTeam";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/meet-the-team");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const meetTheTeam = await contentServer.fetchStaticPageContent("team", {
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return <RouteRenderer entry={MeetTheTeam} pathname="/meet-the-team" searchParams={{}} initialRouteData={{ meetTheTeam }} />;
}
