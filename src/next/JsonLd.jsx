export const serializeJsonLd = (data) =>
  JSON.stringify(data)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export default function JsonLd({ data }) {
  if (!data) return null;
  return (
    <>
      {/* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- JSON is escaped by serializeJsonLd and covered by jsonLdSecurity.test.jsx. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />
    </>
  );
}
