import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export default async function Page({ searchParams }) {
  const homePageData = await contentServer.fetchHomePageData();
  const faqQuestions = homePageData?.faqQuestions || [];
  const faqJsonLd = seo.buildFaqJsonLd(faqQuestions);

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildHomePageJsonLd()} />
      <JsonLd data={seo.buildOfferCatalogJsonLd()} />
      <JsonLd data={faqJsonLd.mainEntity?.length ? faqJsonLd : null} />
      <RouteRenderer
        pathname="/"
        searchParams={searchParams}
        initialHomeData={homePageData}
      />
    </>
  );
}
