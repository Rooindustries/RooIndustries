import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getFaqPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/faq");
export const revalidate = 60;

export default async function Page() {
  const faqPageData = await getFaqPageData();
  return (
    <RouteRenderer pathname="/faq" initialRouteData={{ faq: faqPageData }} />
  );
}
