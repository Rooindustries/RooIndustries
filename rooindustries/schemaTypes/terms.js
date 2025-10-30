export default {
  name: 'terms',
  title: 'Terms and Conditions',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Main Title',
      type: 'string',
    },
    {
      name: 'lastUpdated',
      title: 'Last Updated',
      type: 'string',
    },
    {
      name: 'sections',
      title: 'Sections',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'heading', title: 'Section Heading', type: 'string'},
            {
              name: 'content',
              title: 'Content',
              type: 'array',
              of: [{type: 'block'}],
            },
          ],
        },
      ],
    },
  ],
}
