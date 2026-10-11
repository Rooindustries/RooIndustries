import Privacy from "@/src/legacyPages/PrivacyPolicy";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/privacy");

export default async function Page({ searchParams }) {
  const privacy = await contentServer.fetchPrivacyPolicy();
  return <RouteRenderer pathname="/privacy" searchParams={searchParams} initialRouteData={{ privacy }} initialRouteContent={<Privacy initialData={privacy} />} />;
}
