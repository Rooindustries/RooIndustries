import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import sanityServer from "@/src/lib/sanityServer";

export const metadata = seo.getMetadataForPath("/faq");

export default async function Page({ searchParams }) {
  const faqQuestions = await sanityServer.fetchFaqQuestions();
  const faqJsonLd = seo.buildFaqJsonLd(faqQuestions);

  return (
    <>
      <JsonLd data={faqJsonLd.mainEntity?.length ? faqJsonLd : null} />
      <RouteRenderer pathname="/faq" searchParams={searchParams} />
    </>
  );
}
