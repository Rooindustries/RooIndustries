export default {
  name: 'benchmark',
  title: 'Benchmark',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Benchmark Name',
      type: 'string',
    },
    {
      name: 'beforeImage',
      title: 'Before Image',
      type: 'image',
      options: {hotspot: true},
    },
    {
      name: 'afterImage',
      title: 'After Image',
      type: 'image',
      options: {hotspot: true},
    },
    {
      name: 'reviewImage',
      title: 'Review Image',
      type: 'image',
      options: {hotspot: true},
    },
  ],
}
