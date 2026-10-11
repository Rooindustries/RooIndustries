import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/verify");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/referrals/verify" searchParams={searchParams} />;
}
