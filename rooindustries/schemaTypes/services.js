export default {
  name: 'services',
  title: 'Services',
  type: 'document',
  fields: [
    {
      name: 'heading',
      title: 'Main Heading',
      type: 'string',
    },
    {
      name: 'subheading',
      title: 'Subheading',
      type: 'string',
    },
    {
      name: 'cards',
      title: 'Service Cards',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'title', title: 'Title', type: 'string'},
            {name: 'description', title: 'Description', type: 'text'},
            {
              name: 'iconType',
              title: 'Icon Type',
              type: 'string',
              options: {
                list: [
                  {title: 'Zap', value: 'zap'},
                  {title: 'Clock', value: 'clock'},
                  {title: 'Shield', value: 'shield'},
                  {title: 'Wrench', value: 'wrench'},
                  {title: 'Video', value: 'video'},
                  {title: 'CPU', value: 'cpu'},
                ],
                layout: 'dropdown',
              },
            },
          ],
        },
      ],
    },
  ],
}
