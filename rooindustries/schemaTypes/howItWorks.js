export default {
  name: 'howItWorks',
  title: 'How It Works Section',
  type: 'document',
  fields: [
    {name: 'title', title: 'Section Title', type: 'string'},
    {name: 'subtitle', title: 'Subtitle', type: 'string'},
    {
      name: 'steps',
      title: 'Steps',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'badge', title: 'Step Badge', type: 'string'},
            {name: 'title', title: 'Step Title', type: 'string'},
            {name: 'text', title: 'Step Description', type: 'text'},
            {name: 'faqText', title: 'FAQ Link Text', type: 'string'},
            {name: 'faqLink', title: 'FAQ Link (e.g. /faq#trust)', type: 'string'},
            {
              name: 'iconType',
              title: 'Icon Type',
              type: 'string',
              options: {
                list: [
                  {title: 'Discord', value: 'discord'},
                  {title: 'Download', value: 'download'},
                  {title: 'Microchip', value: 'microchip'},
                  {title: 'Windows', value: 'windows'},
                ],
              },
            },
          ],
        },
      ],
    },
  ],
}
