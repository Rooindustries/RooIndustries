import MeetTheTeam from "@/src/next/entries/MeetTheTeam";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/meet-the-team");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={MeetTheTeam} pathname="/meet-the-team" searchParams={searchParams} />;
}
