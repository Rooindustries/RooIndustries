import Privacy from "@/src/next/entries/PrivacyPolicy";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/privacy");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const privacy = await contentServer.fetchStaticPageContent("privacy-policy", {
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return <RouteRenderer entry={Privacy} pathname="/privacy" searchParams={{}} initialRouteData={{ privacy }} />;
}
