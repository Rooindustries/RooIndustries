import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import sanityServer from "@/src/lib/sanityServer";

export default async function Page({ searchParams }) {
  const homePageData = await sanityServer.fetchHomePageData();
  const faqQuestions = homePageData?.faqQuestions || [];
  const faqJsonLd = seo.buildFaqJsonLd(faqQuestions);

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
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
