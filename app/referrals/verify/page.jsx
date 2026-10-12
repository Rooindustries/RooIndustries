import RefVerifyRegistration from "@/src/next/entries/RefVerifyRegistration";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/verify");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={RefVerifyRegistration} pathname="/referrals/verify" searchParams={searchParams} />;
}
