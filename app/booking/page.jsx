import Book from "@/src/next/entries/Book";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/booking");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={Book} pathname="/booking" searchParams={searchParams} />;
}
