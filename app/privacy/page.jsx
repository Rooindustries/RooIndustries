import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import sanityServer from "@/src/lib/sanityServer";

export const metadata = seo.getMetadataForPath("/privacy");

export default async function Page({ searchParams }) {
  const privacy = await sanityServer.fetchPrivacyPolicy();
  return <RouteRenderer pathname="/privacy" searchParams={searchParams} initialRouteData={{ privacy }} />;
}
