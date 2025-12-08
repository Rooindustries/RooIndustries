export default {
  name: 'coupon',
  title: 'Coupons',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Coupon Name',
      type: 'string',
      description: "Internal name, e.g. 'Black Friday 10% off'",
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'code',
      title: 'Coupon Code',
      type: 'string',
      description: "What customers type at checkout (case-insensitive, e.g. 'BF10')",
      validation: (Rule) => Rule.required().min(2).max(32),
    },
    {
      name: 'discountPercent',
      title: 'Discount Percentage',
      type: 'number',
      description: 'How much discount this coupon gives (0–100)',
      validation: (Rule) => Rule.required().min(0).max(100),
    },
    {
      name: 'isActive',
      title: 'Active',
      type: 'boolean',
      description: 'Turn coupon on/off',
      initialValue: true,
    },
    {
      name: 'canCombineWithReferral',
      title: 'Can be clubbed with referral discount?',
      type: 'boolean',
      description:
        'If ON, this coupon can stack with referral discount. If OFF, user must choose referral OR coupon.',
      initialValue: false,
    },
    {
      name: 'validFrom',
      title: 'Valid From (optional)',
      type: 'datetime',
    },
    {
      name: 'validTo',
      title: 'Valid To (optional)',
      type: 'datetime',
    },
    {
      name: 'notes',
      title: 'Notes',
      type: 'text',
      rows: 3,
    },
  ],
}
