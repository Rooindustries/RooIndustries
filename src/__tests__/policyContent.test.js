const {
  CANCELLATIONS_AND_RESCHEDULING_TEXT,
  MONEY_BACK_FAQ_ANSWER,
  MONEY_BACK_FAQ_QUESTION,
  PAYMENTS_AND_REFUNDS_TEXT,
  TERMS_LAST_UPDATED,
  applyFaqPolicyOverrides,
  applyPublicPolicyOverrides,
  applyTermsPolicyOverrides,
} = require("../lib/policyContent");

const portableText = (text) => [
  {
    _key: "block",
    _type: "block",
    children: [{ _key: "span", _type: "span", text }],
  },
];

const readSectionText = (section) =>
  (section?.content || [])
    .flatMap((block) => block?.children || [])
    .map((child) => child?.text || "")
    .join(" ");

describe("public policy content", () => {
  test("updates the existing refund FAQ without adding a duplicate", () => {
    const source = [
      { question: "What happens during the session?", answer: "We tune it." },
      {
        _key: "refunds",
        question: "Do you offer refunds? What is the warranty?",
        answer: "Old refund wording",
      },
    ];

    const result = applyFaqPolicyOverrides(source);

    expect(result).toHaveLength(source.length);
    expect(result[1]).toMatchObject({
      _key: "refunds",
      question: MONEY_BACK_FAQ_QUESTION,
      answer: MONEY_BACK_FAQ_ANSWER,
    });
    expect(result[1].answer).toContain(
      "no repeatable synthetic performance gains, you will be refunded",
    );
  });

  test("applies the guarantee and free-rescheduling terms", () => {
    const result = applyTermsPolicyOverrides({
      title: "Terms and Conditions",
      lastUpdated: "October 2025",
      sections: [
        {
          _key: "payments",
          heading: "2. Payments and Refunds",
          content: portableText("Old refund policy"),
        },
        {
          _key: "rescheduling",
          heading: "3. Rescheduling Policy",
          content: portableText("One free reschedule, then $15"),
        },
        {
          _key: "privacy",
          heading: "4. Privacy",
          content: portableText("Unchanged"),
        },
      ],
    });

    expect(result.lastUpdated).toBe(TERMS_LAST_UPDATED);
    expect(readSectionText(result.sections[0])).toBe(PAYMENTS_AND_REFUNDS_TEXT);
    expect(result.sections[1].heading).toBe(
      "3. Cancellations and Rescheduling",
    );
    expect(readSectionText(result.sections[1])).toBe(
      CANCELLATIONS_AND_RESCHEDULING_TEXT,
    );
    expect(readSectionText(result.sections[1])).toContain(
      "20% cancellation fee",
    );
    expect(readSectionText(result.sections[1])).toContain(
      "All reschedules are free",
    );
    expect(result.sections[2].content).toEqual(portableText("Unchanged"));
  });

  test("routes only FAQ and terms resources through policy overrides", () => {
    const faq = applyPublicPolicyOverrides("faq-questions", [
      {
        question: "Do you offer refunds? What is the warranty?",
        answer: "Old",
      },
    ]);
    const untouched = { heading: "Packages" };

    expect(faq[0].question).toBe(MONEY_BACK_FAQ_QUESTION);
    expect(applyPublicPolicyOverrides("packages-settings", untouched)).toBe(
      untouched,
    );
  });
});
