import Privacy from "@/src/next/entries/PrivacyPolicy";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/privacy");

export default async function Page({ searchParams }) {
  const privacy = await contentServer.fetchPrivacyPolicy();
  return <RouteRenderer entry={Privacy} pathname="/privacy" searchParams={searchParams} initialRouteData={{ privacy }} />;
}
