import Contact from "@/src/next/entries/Contact";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/contact");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const contact = await contentServer.fetchStaticPageContent("contact", {
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return <RouteRenderer entry={Contact} pathname="/contact" searchParams={{}} initialRouteData={{ contact }} />;
}
