export default {
  name: 'services',
  title: 'Services Section',
  type: 'document',
  fields: [
    {name: 'heading', title: 'Heading', type: 'string'},
    {name: 'subheading', title: 'Subheading', type: 'string'},

    {
      name: 'cards',
      title: 'Top Service Cards',
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
              },
            },
          ],
        },
      ],
    },
    {
      name: 'benchMetricLabel',
      title: 'Metric Label',
      type: 'string',
      initialValue: 'Frames Per Second',
    },
    {name: 'benchBeforeLabel', title: 'Before Label', type: 'string', initialValue: 'Before'},
    {name: 'benchAfterLabel', title: 'Optimized Label', type: 'string', initialValue: 'Optimized'},
    {name: 'benchBadgeSuffix', title: 'Badge Suffix', type: 'string', initialValue: 'FPS'},
    {name: 'benchPagePrefix', title: 'Page Prefix', type: 'string', initialValue: 'Page'},

    {
      name: 'benchPages',
      title: 'Bench Pages',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'benchPage',
          fields: [
            {
              name: 'games',
              title: 'Games (3 per page recommended)',
              type: 'array',
              of: [
                {
                  type: 'object',
                  name: 'benchGame',
                  fields: [
                    {name: 'gameTitle', title: 'Game Title', type: 'string'},
                    {name: 'beforeFps', title: 'Before FPS', type: 'number'},
                    {name: 'afterFps', title: 'Optimized FPS', type: 'number'},
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}
