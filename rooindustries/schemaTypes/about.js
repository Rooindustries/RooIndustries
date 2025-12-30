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
      initialValue: 'Top 20 global CPU profile - official entry',
    },
    {
      name: 'recordButtonText',
      title: 'Record Button Text',
      type: 'string',
      initialValue: 'See official entry',
    },
    {
      name: 'recordNote',
      title: 'Record Note',
      type: 'string',
      initialValue: "We don't just promise performance - we show the receipt.",
    },
    {
      name: 'recordDetails',
      title: 'Record Details',
      type: 'array',
      initialValue: [
        {label: 'Rank', value: '#20', sub: 'Global CPU profile'},
        {label: 'Score', value: '18829', sub: 'Verified'},
        {label: 'Date', value: 'Jun 4, 2025', sub: 'Submission'},
        {label: 'CPU', value: 'AMD Ryzen 9 9950X3D', sub: 'Tuned profile'},
        {label: 'GPU', value: 'NVIDIA GeForce RTX 5080', sub: 'Validated config'},
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
