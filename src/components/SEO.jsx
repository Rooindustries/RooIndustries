import React, { useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_OG_IMAGE,
  DEFAULT_TITLE,
  SITE_NAME,
  SITE_URL,
  resolveUrl,
} from "../seoConfig";

const getRobotsContent = (forceNoindex = false) => {
  const vercelEnv = process.env.REACT_APP_VERCEL_ENV;
  const isProduction = vercelEnv
    ? vercelEnv === "production"
    : process.env.NODE_ENV === "production";
  return forceNoindex || !isProduction ? "noindex,nofollow" : "index,follow";
};

export default function SEO({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  image = DEFAULT_OG_IMAGE,
  type = "website",
  canonicalPath,
  noindex = false,
  jsonLd,
}) {
  const location = useLocation();

  const canonicalUrl = useMemo(() => {
    const path = canonicalPath ?? location.pathname ?? "/";
    if (path === "/") return SITE_URL;
    return `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  }, [canonicalPath, location.pathname]);

  const ogImage = resolveUrl(image);
  const robotsContent = getRobotsContent(noindex);
  const jsonLdEntries = Array.isArray(jsonLd)
    ? jsonLd.filter(Boolean)
    : jsonLd
      ? [jsonLd]
      : [];

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={robotsContent} />
      <link rel="canonical" href={canonicalUrl} />

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={ogImage} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {jsonLdEntries.map((entry, index) => (
        <script
          key={`jsonld-${index}`}
          type="application/ld+json"
        >{`${JSON.stringify(entry)}`}</script>
      ))}
    </Helmet>
  );
}
