export default {
  name: 'paymentWebhookReceipt',
  title: 'Payment Webhook Receipt',
  type: 'document',
  fields: [
    {name: 'provider', type: 'string'},
    {name: 'eventId', type: 'string'},
    {name: 'eventType', type: 'string'},
    {name: 'status', type: 'string'},
    {name: 'leaseId', type: 'string'},
    {name: 'leaseExpiresAt', type: 'datetime'},
    {name: 'httpStatus', type: 'number'},
    {name: 'createdAt', type: 'datetime'},
    {name: 'updatedAt', type: 'datetime'},
    {name: 'processedAt', type: 'datetime'},
  ],
}
