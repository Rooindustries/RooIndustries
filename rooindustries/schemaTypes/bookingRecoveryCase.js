export default {
  name: 'bookingRecoveryCase',
  title: 'Booking Recovery Case',
  type: 'document',
  fields: [
    {name: 'paymentRecordId', title: 'Payment Record ID', type: 'string', readOnly: true},
    {name: 'bookingId', title: 'Booking ID', type: 'string', readOnly: true},
    {name: 'reason', title: 'Reason', type: 'string'},
    {
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {list: ['open', 'notified', 'resolved']},
      initialValue: 'open',
    },
    {name: 'createdAt', title: 'Created At', type: 'datetime'},
    {name: 'notificationStatus', title: 'Notification Status', type: 'string'},
    {name: 'notifiedAt', title: 'Notified At', type: 'datetime'},
    {name: 'resolvedAt', title: 'Resolved At', type: 'datetime'},
  ],
}
