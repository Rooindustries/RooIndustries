import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";
import { logSafeError } from "@/src/server/safeErrorLog";

export const metadata = seo.getMetadataForPath("/tools");

export default async function Page({ searchParams }) {
  let tools = null;
  try {
    tools = await fetchPublicContent({ resource: "tools", searchParams: new URLSearchParams() });
  } catch (error) {
    logSafeError("Tools page content unavailable", error);
  }
  return (
    <div style={{ minHeight: "700px" }}>
      <RouteRenderer pathname="/tools" searchParams={searchParams} initialRouteData={{ tools }} />
    </div>
  );
}
