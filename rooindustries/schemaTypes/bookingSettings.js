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
      description: 'First hour shown in the booking list (e.g. 0 = midnight, 9 = 9 AM).',
      initialValue: 0,
    },
    {
      name: 'closeHour',
      title: 'Closing Hour (24h)',
      type: 'number',
      description: 'Last hour shown (e.g. 23 = 11 PM).',
      initialValue: 23,
    },
    {
      name: 'availableTimes',
      title: 'Weekly Time Slots',
      type: 'object',
      description:
        'Allowed hours per weekday (24h numbers, e.g. 16 = 4 PM, 17 = 5 PM). Empty = closed.',
      fields: [
        {name: 'sunday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'monday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'tuesday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'wednesday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'thursday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'friday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
        {name: 'saturday', type: 'array', of: [{type: 'number'}], options: {layout: 'tags'}},
      ],
    },
  ],
}
