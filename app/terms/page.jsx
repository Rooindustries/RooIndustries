import Terms from "@/src/next/entries/Terms";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/terms");

export default async function Page({ searchParams }) {
  const terms = await contentServer.fetchTerms();
  return <RouteRenderer entry={Terms} pathname="/terms" searchParams={searchParams} initialRouteData={{ terms }} />;
}
