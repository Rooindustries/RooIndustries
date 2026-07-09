export default {
  name: 'paymentStartClaim',
  title: 'Payment Start Claim',
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
