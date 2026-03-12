import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getToolsPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/tools");
export const revalidate = 60;

export default async function Page() {
  const toolsPageData = await getToolsPageData();

  return (
    <div style={{ minHeight: "700px" }}>
      <RouteRenderer pathname="/tools" initialRouteData={{ tools: toolsPageData }} />
    </div>
  );
}
