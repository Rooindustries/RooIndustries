import RouteRenderer from "@/src/next/RouteRenderer";
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
  return <RouteRenderer pathname={path} searchParams={Object.fromEntries(new URLSearchParams(search))} notFound />;
}
