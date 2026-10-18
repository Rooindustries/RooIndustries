import AboutPage from "@/src/next/entries/About";
import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/about");

export default function Page({ searchParams }) {
  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <RouteRenderer entry={AboutPage} pathname="/about" searchParams={searchParams} />
    </>
  );
}
