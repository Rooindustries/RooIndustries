const fields = [
  { name: "priceCents", title: "Price in US cents", type: "number", required: true },
  { name: "currency", title: "Currency", type: "string", required: true },
  { name: "checkedAt", title: "Checked at", type: "string", required: true },
  { name: "source", title: "Source", type: "string", required: true },
  { name: "sourceUrl", title: "Source link", type: "url", required: true },
  { name: "sku", title: "SKU", type: "string", required: true },
  { name: "variantId", title: "Variant", type: "string", required: true },
];

export const ramPriceSchema = [
  {
    name: "ramPrice", title: "Verified RAM Price", type: "object", fields,
    description: "Refreshed automatically from v-color. Keep the source and checked date with the price.",
  },
  {
    name: "ramPriceCandidate", title: "Pending RAM Price", type: "object",
    hidden: true, fields,
  },
];
