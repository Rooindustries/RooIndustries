import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getTermsPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/terms");
export const revalidate = 60;

export default async function Page() {
  const termsPageData = await getTermsPageData();

  return (
    <RouteRenderer
      pathname="/terms"
      initialRouteData={{ terms: termsPageData }}
    />
  );
}
