export default {
  name: 'slotHold',
  title: 'Slot Hold',
  type: 'document',
  fields: [
    {
      name: 'hostDate',
      title: 'Host Date',
      type: 'string',
      description: 'Same format as booking.hostDate / booking.date (toDateString).',
    },
    {
      name: 'hostTime',
      title: 'Host Time',
      type: 'string',
      description: 'Same format as booking.hostTime / booking.time (e.g. 5:00 PM).',
    },
    {
      name: 'startTimeUTC',
      title: 'Start Time (UTC)',
      type: 'datetime',
    },
    {
      name: 'packageTitle',
      title: 'Package Title',
      type: 'string',
    },
    {
      name: 'expiresAt',
      title: 'Expires At',
      type: 'datetime',
      description: 'After this time the hold is ignored.',
    },
  ],
}
