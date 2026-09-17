import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchHomePageData } from "@/src/lib/sanityServer";

export const metadata = seo.getMetadataForPath("/faq");

export default async function Page({ searchParams }) {
  const initialHomeData = await fetchHomePageData();
  return (
    <>
      <noscript>
        <section aria-label="Frequently asked questions" className="mx-auto max-w-6xl px-6 pt-28">
          <h1 className="mb-6 text-4xl font-bold">Frequently asked questions</h1>
          {initialHomeData.faqQuestions.map(({ question, answer }) => (
            <div key={question} className="mb-6">
              <h2 className="text-xl font-semibold">{question}</h2>
              <p className="mt-2 text-ink-secondary">{answer}</p>
            </div>
          ))}
        </section>
      </noscript>
      <RouteRenderer
        pathname="/faq"
        searchParams={searchParams}
        initialHomeData={initialHomeData}
      />
    </>
  );
}
