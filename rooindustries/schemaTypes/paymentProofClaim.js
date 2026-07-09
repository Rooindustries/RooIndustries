export default {
  name: 'paymentProofClaim',
  title: 'Payment Proof Claim',
  type: 'document',
  fields: [
    {name: 'paymentRecordId', type: 'string'},
    {name: 'provider', type: 'string'},
    {name: 'providerOrderId', type: 'string'},
    {name: 'providerPaymentId', type: 'string'},
    {name: 'bookingId', type: 'string'},
    {name: 'status', type: 'string'},
    {name: 'claimedAt', type: 'datetime'},
  ],
}
