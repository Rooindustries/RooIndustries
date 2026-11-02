import Terms from "@/src/next/entries/Terms";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/terms");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const terms = await contentServer.fetchStaticPageContent("terms", {
    requireContent: true,
  });
  return <RouteRenderer entry={Terms} pathname="/terms" searchParams={{}} initialRouteData={{ terms }} />;
}
