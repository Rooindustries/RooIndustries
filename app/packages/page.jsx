import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getPackagesPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/packages");
export const revalidate = 60;

export default async function Page() {
  const packagesPageData = await getPackagesPageData();

  return (
    <>
      <h1 className="sr-only">PC Optimization Packages</h1>
      <RouteRenderer
        pathname="/packages"
        initialRouteData={{ packages: packagesPageData }}
      />
    </>
  );
}
