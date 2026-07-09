// rooidustries/schemaTypes/slotHold.js
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
    {name: 'holdNonce', title: 'Hold Nonce', type: 'string', readOnly: true},
    {
      name: 'phase',
      title: 'Lifecycle Phase',
      type: 'string',
      options: {list: ['active', 'payment_pending', 'released', 'consumed']},
      initialValue: 'active',
    },
    {name: 'paymentRecordId', title: 'Payment Record ID', type: 'string', readOnly: true},
    {name: 'releasedAt', title: 'Released At', type: 'datetime', readOnly: true},
    {name: 'consumedAt', title: 'Consumed At', type: 'datetime', readOnly: true},
  ],
}
