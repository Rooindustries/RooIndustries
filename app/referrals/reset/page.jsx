import RefReset from "@/src/next/entries/RefReset";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/reset");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={RefReset} pathname="/referrals/reset" searchParams={searchParams} />;
}
