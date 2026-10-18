import Faq from "@/src/next/entries/Faq";
import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import { fetchHomePageData } from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/faq");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const initialHomeData = await fetchHomePageData({
    fresh: true,
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
    requiredResources: ["faq-questions"],
  });
  const faqJsonLd = seo.buildFaqJsonLd(initialHomeData.faqQuestions);
  return (
    <>
      <JsonLd data={faqJsonLd.mainEntity.length ? faqJsonLd : null} />
      <noscript>
        <section aria-label="Frequently asked questions" className="mx-auto max-w-6xl px-6 pt-28">
          <h2 className="mb-6 text-4xl font-bold">Frequently asked questions</h2>
          {initialHomeData.faqQuestions.map(({ question, answer }) => (
            <div key={question} className="mb-6">
              <h2 className="text-xl font-semibold">{question}</h2>
              <p className="mt-2 text-ink-secondary">{answer}</p>
            </div>
          ))}
        </section>
      </noscript>
      <RouteRenderer entry={Faq}
        pathname="/faq"
        searchParams={{}}
        initialHomeData={initialHomeData}
      />
    </>
  );
}
