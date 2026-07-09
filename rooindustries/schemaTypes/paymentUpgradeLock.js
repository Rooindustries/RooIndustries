export default {
  name: 'paymentUpgradeLock',
  title: 'Payment Upgrade Lock',
  type: 'document',
  fields: [
    {name: 'scope', type: 'string'},
    {name: 'paymentRecordId', type: 'string'},
    {name: 'provider', type: 'string'},
    {name: 'quoteFingerprint', type: 'string'},
    {name: 'createdAt', type: 'datetime'},
    {name: 'updatedAt', type: 'datetime'},
  ],
}
