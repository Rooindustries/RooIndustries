export default {
  name: 'faqSettings',
  title: 'FAQ Settings',
  type: 'document',
  fields: [
    {
      name: 'eyebrow',
      title: 'Eyebrow Text',
      type: 'string',
      description: 'Small label above the FAQ heading',
    },
    {
      name: 'title',
      title: 'Heading',
      type: 'string',
    },
    {
      name: 'subtitle',
      title: 'Subtitle',
      type: 'text',
      rows: 2,
      description: 'Short line under the heading',
    },
  ],
}
