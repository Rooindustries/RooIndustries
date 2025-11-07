export default {
  name: 'bookingSettings',
  title: 'Booking Settings',
  type: 'document',
  fields: [
    {
      name: 'maxHoursAheadBooking',
      title: 'Maximum Hours Ahead Booking',
      type: 'number',
      description:
        'Users can only book up to this many hours ahead of the current time (e.g., 2 = only within the next 2 hours).',
    },
    {
      name: 'openHour',
      title: 'Opening Hour',
      type: 'number',
      description: 'Hour of day bookings open (24h format, e.g., 16 = 4pm).',
      initialValue: 16,
    },
    {
      name: 'closeHour',
      title: 'Closing Hour',
      type: 'number',
      description: 'Hour of day bookings close (24h format, e.g., 23 = 11pm).',
      initialValue: 23,
    },
  ],
}
