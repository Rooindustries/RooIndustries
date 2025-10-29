export default {
  name: 'review',
  title: 'Reviews',
  type: 'document',
  fields: [
    {name: 'title', title: 'Title', type: 'string'},
    {
      name: 'image',
      title: 'Review Image',
      type: 'image',
      options: {hotspot: true},
    },
    {name: 'alt', title: 'Alt Text', type: 'string'},
  ],
}
