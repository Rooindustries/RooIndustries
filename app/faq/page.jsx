import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchHomePageData } from "@/src/lib/sanityServer";

export const metadata = seo.getMetadataForPath("/faq");

export default async function Page({ searchParams }) {
  const initialHomeData = await fetchHomePageData();
  return (
    <RouteRenderer
      pathname="/faq"
      searchParams={searchParams}
      initialHomeData={initialHomeData}
    />
  );
}
