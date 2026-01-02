const hourOptions = Array.from({length: 24}, (_, i) => ({
  title: `${i}:00`,
  value: `${i}`,
}))

export default {
  name: 'bookingSettings',
  title: 'Booking Settings',
  type: 'document',
  fields: [
    // =====VERTEX SCHEDULE =====
    {
      name: 'maxDaysAheadBooking',
      title: 'Maximum Days Ahead Booking',
      type: 'number',
      initialValue: 7,
    },
    {
      name: 'ownerEmail',
      title: 'Booking Owner Email',
      type: 'string',
      description:
        'Notification destination for new bookings. Overrides OWNER_EMAIL if set.',
      validation: (Rule) => Rule.email().warning('Enter a valid email address.'),
    },
    {
      name: 'packageDateSlots',
      title: 'Package Date Slots',
      type: 'array',
      description:
        'Optional per-package date overrides. If set, these slots take priority for that package.',
      of: [
        {
          type: 'object',
          fields: [
            {
              name: 'package',
              title: 'Package',
              type: 'reference',
              to: [{type: 'package'}],
            },
            {
              name: 'dateSlots',
              title: 'Date Slots',
              type: 'array',
              of: [
                {
                  type: 'object',
                  fields: [
                    {name: 'date', title: 'Date', type: 'date'},
                    {
                      name: 'times',
                      title: 'Available Hours (24h)',
                      type: 'array',
                      of: [{type: 'string'}],
                      options: {layout: 'grid', list: hourOptions},
                    },
                  ],
                },
              ],
            },
          ],
          preview: {
            select: {title: 'package.title'},
            prepare: ({title}) => ({
              title: title || 'Package',
            }),
          },
        },
      ],
    },
    {
      name: 'dateSlots',
      title: 'Date-Based Time Slots (Vertex / Default)',
      type: 'array',
      description: 'Add specific dates with available hours.',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'date', title: 'Date', type: 'date'},
            {
              name: 'times',
              title: 'Available Hours (24h)',
              type: 'array',
              of: [{type: 'string'}],
              options: {layout: 'grid', list: hourOptions},
            },
          ],
        },
      ],
    },
    {
      name: 'vertexEssentialsDateSlots',
      title: 'Date-Based Time Slots (Vertex Essentials)',
      type: 'array',
      description: 'Add specific dates with available hours.',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'date', title: 'Date', type: 'date'},
            {
              name: 'times',
              title: 'Available Hours (24h)',
              type: 'array',
              of: [{type: 'string'}],
              options: {layout: 'grid', list: hourOptions},
            },
          ],
        },
      ],
    },

    // ===== XOC SCHEDULE (separate fields) =====
    {
      name: 'xocDateSlots',
      title: 'Date-Based Time Slots (XOC / Extreme Overclocking)',
      type: 'array',
      description: 'Add specific dates with available hours.',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'date', title: 'Date', type: 'date'},
            {
              name: 'times',
              title: 'Available Hours (24h)',
              type: 'array',
              of: [{type: 'string'}],
              options: {layout: 'grid', list: hourOptions},
            },
          ],
        },
      ],
    },
  ],
}
