export default {
  name: 'rateLimitBucket',
  title: 'Rate Limit Bucket',
  type: 'document',
  fields: [
    {name: 'count', type: 'number', readOnly: true},
    {name: 'resetAt', type: 'datetime', readOnly: true},
    {name: 'createdAt', type: 'datetime', readOnly: true},
  ],
  preview: {
    select: {count: 'count', resetAt: 'resetAt'},
    prepare({count, resetAt}) {
      return {title: `Rate limit bucket (${count || 0})`, subtitle: resetAt || ''}
    },
  },
}
