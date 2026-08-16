const MONEY_BACK_FAQ_QUESTION =
  "Do you offer a money-back guarantee? What is the warranty?";
const MONEY_BACK_FAQ_ANSWER =
  "We offer a 3-day Money-Back Guarantee. If a completed optimization produces no repeatable synthetic performance gains, you will be refunded. Performance Vertex Overhaul includes a 30-day warranty, while Performance Vertex Max includes a lifetime warranty with a 24–48 hour turnaround time. Even after the warranty expires, I’ll still try to help and guide you at my discretion. No man left behind!";
const TERMS_LAST_UPDATED = "August 16, 2026";
const PAYMENTS_AND_REFUNDS_TEXT =
  "All payments for our services must be made in full at the time of purchase. We offer a 3-day Money-Back Guarantee after a completed optimization session: if the service produces no repeatable synthetic performance gains, you will be refunded. Refund requests must be emailed to serviroo@rooindustries.com within 3 days of the service date. Refunds outside this guarantee are not available once the service has been successfully completed. Refunds may take up to 14 working days to appear in your original payment method. Chargebacks or breaches of these terms void the warranty and are not eligible for a refund.";
const CANCELLATIONS_AND_RESCHEDULING_TEXT =
  "All client-requested cancellations incur a 20% cancellation fee to cover the appointment time reserved and the resulting scheduling disruption. The remaining 80% of the original service payment will be refunded to the original payment method. All reschedules are free. Contact serviroo@rooindustries.com as early as possible to move your session.";

const isMoneyBackFaq = (item = {}) => {
  const question = String(item?.question || "");
  return /refund|money[- ]back/i.test(question) && /warranty/i.test(question);
};

const applyFaqPolicyOverrides = (items = []) =>
  Array.isArray(items)
    ? items.map((item) =>
        isMoneyBackFaq(item)
          ? {
              ...item,
              question: MONEY_BACK_FAQ_QUESTION,
              answer: MONEY_BACK_FAQ_ANSWER,
            }
          : item,
      )
    : items;

const createPortableTextBlock = (key, text) => ({
  _key: key,
  _type: "block",
  style: "normal",
  markDefs: [],
  children: [
    {
      _key: `${key}-span`,
      _type: "span",
      marks: [],
      text,
    },
  ],
});

const applyTermsSectionOverride = (section = {}, index = 0) => {
  const heading = String(section?.heading || "");
  if (/payments and refunds/i.test(heading)) {
    return {
      ...section,
      content: [
        createPortableTextBlock(
          section?._key || `payments-refunds-${index}`,
          PAYMENTS_AND_REFUNDS_TEXT,
        ),
      ],
    };
  }
  if (/rescheduling policy|cancellations and rescheduling/i.test(heading)) {
    return {
      ...section,
      heading: "3. Cancellations and Rescheduling",
      content: [
        createPortableTextBlock(
          section?._key || `cancellations-rescheduling-${index}`,
          CANCELLATIONS_AND_RESCHEDULING_TEXT,
        ),
      ],
    };
  }
  return section;
};

const applyTermsPolicyOverrides = (value) => {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    lastUpdated: TERMS_LAST_UPDATED,
    sections: Array.isArray(value.sections)
      ? value.sections.map(applyTermsSectionOverride)
      : value.sections,
  };
};

const applyPublicPolicyOverrides = (resource, value) => {
  if (resource === "faq-questions") return applyFaqPolicyOverrides(value);
  if (resource === "terms") return applyTermsPolicyOverrides(value);
  return value;
};

const api = {
  CANCELLATIONS_AND_RESCHEDULING_TEXT,
  MONEY_BACK_FAQ_ANSWER,
  MONEY_BACK_FAQ_QUESTION,
  PAYMENTS_AND_REFUNDS_TEXT,
  TERMS_LAST_UPDATED,
  applyFaqPolicyOverrides,
  applyPublicPolicyOverrides,
  applyTermsPolicyOverrides,
};

module.exports = api;
module.exports.default = api;
