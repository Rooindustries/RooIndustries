import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";

export const metadata = seo.getMetadataForPath("/tools");

export default async function Page({ searchParams }) {
  const tools = await fetchPublicContent({ resource: "tools", searchParams: new URLSearchParams() });
  return (
    <div style={{ minHeight: "700px" }}>
      <RouteRenderer pathname="/tools" searchParams={searchParams} initialRouteData={{ tools }} />
    </div>
  );
}
