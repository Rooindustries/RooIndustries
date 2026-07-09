export default {
  name: 'bookingSlot',
  title: 'Booking Slot Lock',
  type: 'document',
  fields: [
    {name: 'startTimeUTC', title: 'Start Time (UTC)', type: 'datetime'},
    {name: 'bookingId', title: 'Booking ID', type: 'string', readOnly: true},
    {
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {list: ['active', 'released']},
      initialValue: 'active',
    },
    {name: 'lockedAt', title: 'Locked At', type: 'datetime', readOnly: true},
    {name: 'releasedAt', title: 'Released At', type: 'datetime', readOnly: true},
    {name: 'releaseReason', title: 'Release Reason', type: 'string', readOnly: true},
  ],
}
