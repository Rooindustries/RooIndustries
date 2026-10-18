import Tools from "@/src/next/entries/Tools";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/tools");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const tools = await contentServer.fetchStaticPageContent("tools", {
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return (
    <div style={{ minHeight: "700px" }}>
      <RouteRenderer entry={Tools} pathname="/tools" searchParams={{}} initialRouteData={{ tools }} />
    </div>
  );
}
