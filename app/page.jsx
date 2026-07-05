import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import homeCopy from "@/src/lib/homeCopy";
import seo from "@/src/lib/seo";
import sanityServer from "@/src/lib/sanityServer";

const { HOME_COPY } = homeCopy;
const homeHero = HOME_COPY.hero;

const HomeCrawlerSummary = () => (
  <section className="sr-only" aria-label="Roo Industries service summary">
    <h2>
      {homeHero.headingLine1} {homeHero.headingLine2}
    </h2>
    <p>{homeHero.description}</p>
    <p>{homeHero.subtext}</p>
    <ul>
      {homeHero.bullets.map((bullet) => (
        <li key={bullet}>{bullet}</li>
      ))}
    </ul>
  </section>
);

export default async function Page({ searchParams }) {
  const homePageData = await sanityServer.fetchHomePageData();
  const faqQuestions = homePageData?.faqQuestions || [];
  const faqJsonLd = seo.buildFaqJsonLd(faqQuestions);

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildHomePageJsonLd()} />
      <JsonLd data={seo.buildOfferCatalogJsonLd()} />
      <JsonLd data={faqJsonLd.mainEntity?.length ? faqJsonLd : null} />
      <HomeCrawlerSummary />
      <RouteRenderer
        pathname="/"
        searchParams={searchParams}
        initialHomeData={homePageData}
      />
    </>
  );
}
