import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/forgot");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/referrals/forgot" searchParams={searchParams} />;
}
