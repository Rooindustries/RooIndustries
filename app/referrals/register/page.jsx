import RefRegister from "@/src/next/entries/RefRegister";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/register");

export default function Page({ searchParams }) {
  return (
    <RouteRenderer entry={RefRegister} pathname="/referrals/register" searchParams={searchParams} />
  );
}
