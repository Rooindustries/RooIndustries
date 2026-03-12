import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getContactPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/contact");
export const revalidate = 60;

export default async function Page() {
  const contactPageData = await getContactPageData();

  return (
    <RouteRenderer
      pathname="/contact"
      initialRouteData={{ contact: contactPageData }}
    />
  );
}
