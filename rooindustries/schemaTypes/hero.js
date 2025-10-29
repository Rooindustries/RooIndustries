export default {
  name: 'hero',
  title: 'Hero Section',
  type: 'document',
  fields: [
    {name: 'tagline', title: 'Tagline', type: 'string'},
    {name: 'headingLine1', title: 'Main Heading (Line 1)', type: 'string'},
    {name: 'headingLine2', title: 'Main Heading (Line 2)', type: 'string'},
    {name: 'description', title: 'Short Description', type: 'text', rows: 3},
    {name: 'subtext', title: 'Small Highlight Text', type: 'string'},
    {
      name: 'bullets',
      title: 'Bottom Bullet Points',
      type: 'array',
      of: [{type: 'string'}],
    },
  ],
}
