import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";

export const metadata = seo.getMetadataForPath("/contact");

export default async function Page({ searchParams }) {
  const contact = await fetchPublicContent({ resource: "contact", searchParams: new URLSearchParams() }).catch(() => null);
  return <RouteRenderer pathname="/contact" searchParams={searchParams} initialRouteData={{ contact }} />;
}
