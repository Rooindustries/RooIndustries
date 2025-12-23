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
            // 1. Existing Dropdown
            {
              name: 'iconType',
              title: 'Icon (Preset)',
              type: 'string',
              description: 'Select a built-in icon OR upload a custom one below.',
              options: {
                list: [
                  {title: 'Zap (Lightning)', value: 'zap'},
                  {title: 'Clock (Time)', value: 'clock'},
                  {title: 'Shield (Security)', value: 'shield'},
                  {title: 'Wrench (Tools)', value: 'wrench'},
                  {title: 'Video (Camera)', value: 'video'},
                  {title: 'CPU (Processor)', value: 'cpu'},
                ],
              },
            },
            // 2. New Image Upload Field
            {
              name: 'customIcon',
              title: 'Custom Icon (Upload)',
              type: 'image',
              description: 'Upload an SVG or PNG. This overrides the preset icon selection.',
              options: {
                hotspot: true, // Allows cropping if needed
              },
            },
          ],
        },
      ],
    },
    // ... existing benchmark fields ...
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
                    {
                      name: 'gameLogo',
                      title: 'Game Logo',
                      type: 'image',
                      options: {
                        hotspot: true,
                      },
                    },
                    {name: 'beforeFps', title: 'Before FPS', type: 'number'},
                    {name: 'afterFps', title: 'Optimized FPS', type: 'number'},
                    {name: 'gpu', title: 'GPU', type: 'string'},
                    {name: 'cpu', title: 'CPU', type: 'string'},
                    {name: 'ram', title: 'RAM', type: 'string'},
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
