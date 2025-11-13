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
    },

    // Owner sets how much max value this creator can control
    {
      name: 'maxCommissionPercent',
      title: 'Max Total % Allowed',
      type: 'number',
      initialValue: 15,
      description: 'Creator can divide this between commission and discount',
    },

    // Creator chosen % (updated by their dashboard)
    {
      name: 'currentCommissionPercent',
      title: 'Creator Commission %',
      type: 'number',
      description: 'Creator chosen percentage from the max allowed',
      initialValue: 10,
    },

    {
      name: 'currentDiscountPercent',
      title: 'Viewer Discount %',
      type: 'number',
      description: 'Percentage viewers get from the max allowed',
      initialValue: 5,
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
      name: 'creatorPassword',
      title: 'Password (for dashboard login)',
      type: 'string',
    },
  ],
}
