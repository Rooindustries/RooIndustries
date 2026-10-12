import Thankyou from "@/src/next/entries/Thankyou";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/thank-you");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={Thankyou} pathname="/thank-you" searchParams={searchParams} />;
}
