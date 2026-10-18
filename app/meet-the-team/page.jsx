import MeetTheTeam from "@/src/next/entries/MeetTheTeam";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";
import { logSafeError } from "@/src/server/safeErrorLog";

export const metadata = seo.getMetadataForPath("/meet-the-team");

export default async function Page({ searchParams }) {
  let meetTheTeam = null;
  try {
    meetTheTeam = await fetchPublicContent({ resource: "team", searchParams: new URLSearchParams() });
  } catch (error) {
    logSafeError("Team page content unavailable", error);
  }
  return <RouteRenderer entry={MeetTheTeam} pathname="/meet-the-team" searchParams={searchParams} initialRouteData={{ meetTheTeam }} />;
}
