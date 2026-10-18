import Packages from "@/src/next/entries/Packages";
import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import { applyHomeSectionCopyOverride } from "@/src/lib/homeCopy";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/packages");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const { packagesList, packagesSettings } = await contentServer.fetchPackagesPageData({
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  const packagesData = {
    packagesList,
    packagesSettings: applyHomeSectionCopyOverride("packages-settings", packagesSettings),
  };
  return (
    <>
      <JsonLd data={seo.buildOfferCatalogJsonLd(packagesList)} />
      <RouteRenderer
        entry={Packages}
        pathname="/packages"
        searchParams={{}}
        initialRouteData={{ packages: packagesData }}
      />
    </>
  );
}
