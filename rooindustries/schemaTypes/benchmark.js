export default {
  name: 'benchmark',
  title: 'Benchmark',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Benchmark Name',
      type: 'string',
      description: 'Name of the benchmark',
    },
    {
      name: 'subtitle',
      title: 'Subtitle / Small Description',
      type: 'string',
      description: 'Short optional description under the title.',
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
      title: 'Review Image (Discord Screenshot)',
      type: 'image',
      options: {hotspot: true},
    },
  ],
}
