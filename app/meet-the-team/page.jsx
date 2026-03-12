import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getMeetTheTeamPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/meet-the-team");
export const revalidate = 60;

export default async function Page() {
  const meetTheTeamPageData = await getMeetTheTeamPageData();

  return (
    <RouteRenderer
      pathname="/meet-the-team"
      initialRouteData={{ meetTheTeam: meetTheTeamPageData }}
    />
  );
}
