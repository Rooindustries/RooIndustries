import { defineField, defineType } from "sanity";

export default defineType({
  name: "referralIdentityClaim",
  title: "Referral Identity Claim",
  type: "document",
  fields: [
    defineField({ name: "kind", type: "string", readOnly: true }),
    defineField({ name: "referral", type: "reference", to: [{ type: "referral" }], readOnly: true }),
    defineField({ name: "createdAt", type: "datetime", readOnly: true }),
  ],
});
