export default {
  name: 'paymentRecoveryCase',
  title: 'Payment Recovery Case',
  type: 'document',
  fields: [
    {name: 'paymentRecordId', type: 'string'},
    {name: 'bookingId', type: 'string'},
    {name: 'reason', type: 'string'},
    {name: 'status', type: 'string'},
    {name: 'requiresReschedule', type: 'boolean'},
    {name: 'createdAt', type: 'datetime'},
    {name: 'updatedAt', type: 'datetime'},
    {name: 'resolvedAt', type: 'datetime'},
  ],
}
