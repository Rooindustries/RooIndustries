export default {
  name: 'referral',
  title: 'Referral Creators',
  type: 'document',
  fields: [
    {
      name: 'name',
      title: 'Creator Name',
      type: 'string',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'slug',
      title: 'Referral Code',
      type: 'slug',
      options: {
        source: 'name',
        slugify: (input) =>
          input
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w-]+/g, '')
            .slice(0, 50),
      },
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'maxCommissionPercent',
      title: 'Max Total % Allowed',
      type: 'number',
      initialValue: 15,
    },

    {
      name: 'currentCommissionPercent',
      title: 'Creator Commission %',
      type: 'number',
      initialValue: 10,
    },

    {
      name: 'currentDiscountPercent',
      title: 'Viewer Discount %',
      type: 'number',
      initialValue: 0,
    },
    {
      name: 'paypalEmail',
      title: 'PayPal Email',
      type: 'string',
    },
    {
      name: 'contactDiscord',
      title: 'Discord (optional)',
      type: 'string',
    },
    {
      name: 'contactTelegram',
      title: 'Telegram / Signal (optional)',
      type: 'string',
    },
    {
      name: 'contactPhone',
      title: 'Phone (optional)',
      type: 'string',
    },
    {
      name: 'xocPayments',
      title: 'XOC Payment Log',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'paymentLogXoc',
          title: 'XOC Payment',
          fields: [
            {
              name: 'amount',
              title: 'Amount Paid (USD)',
              type: 'number',
              validation: (Rule) => Rule.required().min(0),
            },
            {
              name: 'paidOn',
              title: 'Paid On',
              type: 'datetime',
              validation: (Rule) => Rule.required(),
            },
            {
              name: 'note',
              title: 'Note / Reference',
              type: 'string',
              description: 'Invoice ID or transaction reference (optional).',
            },
          ],
          preview: {
            select: {amount: 'amount', paidOn: 'paidOn', note: 'note'},
            prepare({amount, paidOn, note}) {
              const date = paidOn ? new Date(paidOn).toLocaleDateString() : '';
              const title = amount ? `$${amount} paid` : 'Payment';
              const subtitle = [date, note].filter(Boolean).join(' • ');
              return {title, subtitle};
            },
          },
        },
      ],
    },
    {
      name: 'vertexPayments',
      title: 'Vertex Payment Log',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'paymentLogVertex',
          title: 'Vertex Payment',
          fields: [
            {
              name: 'amount',
              title: 'Amount Paid (USD)',
              type: 'number',
              validation: (Rule) => Rule.required().min(0),
            },
            {
              name: 'paidOn',
              title: 'Paid On',
              type: 'datetime',
              validation: (Rule) => Rule.required(),
            },
            {
              name: 'note',
              title: 'Note / Reference',
              type: 'string',
              description: 'Invoice ID or transaction reference (optional).',
            },
          ],
          preview: {
            select: {amount: 'amount', paidOn: 'paidOn', note: 'note'},
            prepare({amount, paidOn, note}) {
              const date = paidOn ? new Date(paidOn).toLocaleDateString() : '';
              const title = amount ? `$${amount} paid` : 'Payment';
              const subtitle = [date, note].filter(Boolean).join(' • ');
              return {title, subtitle};
            },
          },
        },
      ],
    },
    {
      name: 'earnedXoc',
      title: 'Earned (XOC)',
      type: 'number',
      readOnly: true,
      description: 'Calculated from bookings. Not editable.',
    },
    {
      name: 'earnedVertex',
      title: 'Earned (Vertex)',
      type: 'number',
      readOnly: true,
      description: 'Calculated from bookings. Not editable.',
    },
    {
      name: 'earnedTotal',
      title: 'Earned (Total)',
      type: 'number',
      readOnly: true,
      description: 'Calculated from bookings. Not editable.',
    },
    {
      name: 'paidXoc',
      title: 'Paid (XOC)',
      type: 'number',
      readOnly: true,
      description: 'Sum of XOC payment log. Not editable.',
    },
    {
      name: 'paidVertex',
      title: 'Paid (Vertex)',
      type: 'number',
      readOnly: true,
      description: 'Sum of Vertex payment log. Not editable.',
    },
    {
      name: 'paidTotal',
      title: 'Paid (Total)',
      type: 'number',
      readOnly: true,
      description: 'Sum of all payments. Not editable.',
    },
    {
      name: 'owedTotal',
      title: 'Owed (Total)',
      type: 'number',
      readOnly: true,
      description: 'Total remaining balance. Not editable.',
    },
    {
      name: 'notes',
      title: 'Internal Notes (admin only)',
      type: 'text',
      description: 'Private notes for admins. Not shown to creators.',
    },
    {
      name: 'creatorEmail',
      title: 'Creator Email',
      type: 'string',
      description: 'Used for password reset emails.',
      validation: (Rule) => Rule.required().regex(/.+@.+\..+/, 'Enter a valid email'),
    },

    {
      name: 'successfulReferrals',
      title: 'Successful Referrals',
      type: 'number',
      initialValue: 0,
    },

    {
      name: 'bypassUnlock',
      title: 'Bypass 5 Referral Requirement',
      type: 'boolean',
      description:
        'If enabled, this creator can adjust commission & discount without needing 5 successful referrals.',
      initialValue: false,
    },

    {
      name: 'isFirstTime',
      title: 'First Time Creator',
      type: 'boolean',
      initialValue: true,
      hidden: true,
    },

    {
      name: 'resetToken',
      title: 'Password Reset Token',
      type: 'string',
      hidden: true,
    },

    {
      name: 'resetTokenExpiresAt',
      title: 'Password Reset Expiry',
      type: 'datetime',
      hidden: true,
    },

    {
      name: 'creatorPassword',
      title: 'Password (plain or hashed)',
      type: 'string',
      description: 'You can type a normal password here. It will be auto-hashed on first login.',
    },
  ],
}
