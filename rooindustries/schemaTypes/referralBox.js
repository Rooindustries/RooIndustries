export default {
  name: 'referralBox',
  title: 'Referral Box',
  type: 'document',
  fields: [
    {
      name: 'heading',
      title: 'Heading',
      type: 'string',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 3,
    },
    {
      name: 'emailPlaceholder',
      title: 'Email Placeholder',
      type: 'string',
      initialValue: 'Enter your email...',
    },
    {
      name: 'startButtonText',
      title: 'Get Started Button Text',
      type: 'string',
      initialValue: 'Get Started',
    },
    {
      name: 'loginButtonText',
      title: 'Login Button Text',
      type: 'string',
      initialValue: 'Login',
    },
    {
      name: 'registerPath',
      title: 'Register Path',
      type: 'string',
      initialValue: '/referrals/register',
    },
    {
      name: 'loginPath',
      title: 'Login Path',
      type: 'string',
      initialValue: '/login',
    },
  ],
  preview: {
    select: {title: 'heading'},
    prepare({title}) {
      return {title: title || 'Referral Box'}
    },
  },
}
