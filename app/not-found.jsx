import NotFoundEntry from "@/src/next/NotFoundEntry";
import SeoFallback from "@/src/next/SeoFallback";
import seo from "@/src/lib/seo";
import { connection } from "next/server";
import { headers } from "next/headers";

export const metadata = seo.getMetadataForPath("/404");

export default async function NotFound() {
  await connection();
  const requestHeaders = await headers();
  const requestedPath = requestHeaders.get("x-roo-request-path") || "";
  const path = requestedPath.startsWith("/") && !requestedPath.startsWith("//")
    ? requestedPath
    : "/__missing__";
  const search = requestHeaders.get("x-roo-request-search") || "";
  const query = new URLSearchParams(search);
  const searchParams = Object.fromEntries(
    [...new Set(query.keys())].map((key) => {
      const values = query.getAll(key);
      return [key, values.length > 1 ? values : values[0]];
    })
  );
  return (
    <>
      <SeoFallback pathname={path} />
      <NotFoundEntry pathname={path} searchParams={searchParams} initialHomeData={null} initialRouteData={null} notFound />
    </>
  );
}
