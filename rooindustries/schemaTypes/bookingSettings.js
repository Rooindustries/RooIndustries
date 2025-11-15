const hourOptions = Array.from({length: 24}, (_, i) => ({
  title: `${i}:00`,
  value: `${i}`,
}))

export default {
  name: 'bookingSettings',
  title: 'Booking Settings',
  type: 'document',
  fields: [
    {
      name: 'maxDaysAheadBooking',
      title: 'Maximum Days Ahead Booking',
      type: 'number',
      initialValue: 7,
    },
    {
      name: 'openHour',
      title: 'Opening Hour (24h)',
      type: 'number',
      initialValue: 0,
    },
    {
      name: 'closeHour',
      title: 'Closing Hour (24h)',
      type: 'number',
      initialValue: 23,
    },
    {
      name: 'availableTimes',
      title: 'Weekly Time Slots',
      type: 'object',
      fields: [
        {
          name: 'sunday',
          title: 'Sunday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'monday',
          title: 'Monday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'tuesday',
          title: 'Tuesday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'wednesday',
          title: 'Wednesday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'thursday',
          title: 'Thursday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'friday',
          title: 'Friday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
        {
          name: 'saturday',
          title: 'Saturday',
          type: 'array',
          of: [{type: 'string'}],
          options: {
            layout: 'grid',
            list: hourOptions,
          },
        },
      ],
    },
  ],
}
