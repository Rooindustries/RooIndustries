export default {
  name: 'faqSection',
  title: 'FAQ',
  type: 'document',
  fields: [
    {
      name: 'questions',
      title: 'Questions',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {
              name: 'question',
              title: 'Question',
              type: 'string',
            },
            {
              name: 'answer',
              title: 'Answer',
              type: 'text',
              rows: 4,
            },
          ],
        },
      ],
    },
  ],
}
