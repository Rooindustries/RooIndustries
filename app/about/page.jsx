import AboutPage from "@/src/next/entries/About";
import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/about");
export const dynamic = "force-static";
export const revalidate = 60;

export default function Page() {
  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <RouteRenderer entry={AboutPage} pathname="/about" searchParams={{}} />
    </>
  );
}
