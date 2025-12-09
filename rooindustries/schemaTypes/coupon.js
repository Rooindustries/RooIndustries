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
      name: 'maxUses',
      title: 'Maximum Uses (optional)',
      type: 'number',
      description: 'Total number of times this coupon can be used. Leave empty for unlimited.',
      validation: (Rule) => Rule.min(1).warning('Leave empty for unlimited uses.'),
    },
    {
      name: 'timesUsed',
      title: 'Times Used',
      type: 'number',
      description: 'How many times this coupon has been used (auto-updated).',
      readOnly: true,
      initialValue: 0,
    },

    {
      name: 'notes',
      title: 'Notes',
      type: 'text',
      rows: 3,
    },
  ],
}
