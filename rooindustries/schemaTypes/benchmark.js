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
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      description: 'Lower numbers appear first on the site (0, 1, 2, ...).',
      initialValue: 0,
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

  orderings: [
    {
      title: 'Sort Order (low → high)',
      name: 'sortOrderAsc',
      by: [{field: 'sortOrder', direction: 'asc'}],
    },
    {
      title: 'Newest first',
      name: 'createdAtDesc',
      by: [{field: '_createdAt', direction: 'desc'}],
    },
  ],
}
