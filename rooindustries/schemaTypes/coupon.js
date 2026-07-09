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
      name: 'discountType',
      title: 'Discount Type',
      type: 'string',
      description: 'Percent off or a fixed USD amount off.',
      initialValue: 'percent',
      options: {
        list: [
          {title: 'Percent off', value: 'percent'},
          {title: 'Fixed USD off', value: 'fixed'},
        ],
        layout: 'radio',
      },
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'discountPercent',
      title: 'Discount Percentage',
      type: 'number',
      description: 'How much discount this coupon gives (0–100)',
      hidden: ({parent}) => parent?.discountType === 'fixed',
      validation: (Rule) =>
        Rule.custom((value, context) => {
          const type = context?.parent?.discountType || 'percent'
          if (type !== 'percent') return true
          if (typeof value !== 'number') return 'Percent coupons need a discount percentage.'
          if (value < 0 || value > 100) return 'Discount percentage must be between 0 and 100.'
          return true
        }),
    },
    {
      name: 'discountAmount',
      title: 'Discount Amount (USD)',
      type: 'number',
      description: 'Fixed USD amount off the selected package.',
      hidden: ({parent}) => (parent?.discountType || 'percent') !== 'fixed',
      validation: (Rule) =>
        Rule.custom((value, context) => {
          const type = context?.parent?.discountType || 'percent'
          if (type !== 'fixed') return true
          if (typeof value !== 'number') return 'Fixed coupons need a USD amount.'
          if (value <= 0) return 'Discount amount must be greater than 0.'
          return true
        }),
    },
    {
      name: 'eligiblePackages',
      title: 'Eligible Packages',
      type: 'array',
      description: 'Limit this coupon to selected packages. Leave empty to allow all packages.',
      of: [
        {
          type: 'reference',
          to: [{type: 'package'}],
        },
      ],
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
      name: 'activeReservations',
      title: 'Active Checkout Reservations',
      type: 'number',
      readOnly: true,
      initialValue: 0,
      description: 'Temporary reservations made before a provider order is exposed.',
    },
    {name: 'autoDeactivatedByRedemptionId', type: 'string', readOnly: true, hidden: true},
    {name: 'autoDeactivatedAt', type: 'datetime', readOnly: true, hidden: true},
    {
      name: 'redemptionCount',
      title: 'Tracked Redemption Documents',
      type: 'number',
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
