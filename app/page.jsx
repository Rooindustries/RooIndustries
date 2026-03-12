import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import { getHomePageData } from "@/src/lib/sanityPageData";

export const revalidate = 60;

export default async function Page() {
  const homePageData = await getHomePageData();
  const faqQuestions = homePageData?.faqQuestions || [];
  const faqJsonLd = seo.buildFaqJsonLd(faqQuestions);

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildOfferCatalogJsonLd()} />
      <JsonLd data={faqJsonLd.mainEntity?.length ? faqJsonLd : null} />
      <RouteRenderer pathname="/" initialRouteData={{ home: homePageData }} />
    </>
  );
}
