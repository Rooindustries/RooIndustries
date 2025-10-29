export default {
  name: 'about',
  title: 'About Section',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Section Title',
      type: 'string',
      initialValue: 'About Me',
    },
    {
      name: 'description',
      title: 'Main Description',
      type: 'text',
      rows: 8,
    },
    {
      name: 'recordTitle',
      title: 'Record Title',
      type: 'string',
      initialValue: 'Global CPU Overclocking Record Position',
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
