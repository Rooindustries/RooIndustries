import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getPrivacyPolicyPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/privacy");
export const revalidate = 60;

export default async function Page() {
  const privacyPolicyPageData = await getPrivacyPolicyPageData();

  return (
    <RouteRenderer
      pathname="/privacy"
      initialRouteData={{ privacy: privacyPolicyPageData }}
    />
  );
}
