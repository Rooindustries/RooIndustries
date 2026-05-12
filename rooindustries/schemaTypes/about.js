export default {
  name: 'about',
  title: 'About Section',
  type: 'document',
  fields: [
    {
      name: 'recordTitle',
      title: 'Record Title',
      type: 'string',
      initialValue: '3DMark Hall of Fame',
    },
    {
      name: 'recordBadgeText',
      title: 'Record Badge Text',
      type: 'string',
      initialValue: 'Proof',
    },
    {
      name: 'recordSubtitle',
      title: 'Record Subtitle',
      type: 'string',
      initialValue: 'CPU Profile Global Hall of Fame - Official Entry',
    },
    {
      name: 'recordButtonText',
      title: 'Record Button Text',
      type: 'string',
      initialValue: 'See Official Leaderboard',
    },
    {
      name: 'recordNote',
      title: 'Record Note',
      type: 'string',
      initialValue: 'Former #16 global CPU profile',
    },
    {
      name: 'recordDetails',
      title: 'Record Details',
      type: 'array',
      initialValue: [
        {label: 'RANK', value: '#31', sub: ''},
        {label: 'SCORE', value: '18829', sub: ''},
        {label: 'DATE', value: 'Jun 4, 2025', sub: ''},
        {label: 'CPU', value: 'AMD Ryzen 9 9950X3D', sub: ''},
        {label: 'GPU', value: 'NVIDIA GeForce RTX 5080', sub: ''},
      ],
      of: [
        {
          type: 'object',
          fields: [
            {name: 'label', title: 'Label', type: 'string'},
            {name: 'value', title: 'Value', type: 'string'},
            {name: 'sub', title: 'Subtext', type: 'string'},
          ],
        },
      ],
    },
    {
      name: 'recordImage',
      title: 'Record Image',
      type: 'image',
      options: {hotspot: true},
    },
    {
      name: 'recordLink',
      title: 'Record Link',
      type: 'url',
    },
  ],
}
