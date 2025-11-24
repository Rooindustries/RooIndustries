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
      name: 'notes',
      title: 'Notes',
      type: 'text',
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
