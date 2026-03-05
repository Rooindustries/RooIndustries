import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/payment-success");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/payment-success" searchParams={searchParams} />;
}
