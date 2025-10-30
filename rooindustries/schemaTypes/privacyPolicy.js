export default {
  name: 'privacyPolicy',
  title: 'Privacy Policy Page',
  type: 'document',
  fields: [
    {name: 'title', title: 'Page Title', type: 'string'},
    {
      name: 'sections',
      title: 'Sections',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'heading', title: 'Heading', type: 'string'},
            {name: 'content', title: 'Content', type: 'array', of: [{type: 'block'}]},
          ],
        },
      ],
    },
    {name: 'lastUpdated', title: 'Last Updated', type: 'string'},
  ],
}
