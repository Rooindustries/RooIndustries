export default {
  name: 'supportedGames',
  title: 'Supported Games Section',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Title',
      type: 'string',
      initialValue: 'Supported Games',
    },
    {name: 'subtitle', title: 'Subtitle', type: 'string'},
    {
      name: 'showAllLabel',
      title: 'Show All Button Label',
      type: 'string',
      initialValue: 'Show All',
    },
    {
      name: 'showLessLabel',
      title: 'Show Less Button Label',
      type: 'string',
      initialValue: 'Show Less',
    },
    {
      name: 'featuredGames',
      title: 'Featured Games (max 6)',
      type: 'array',
      validation: (Rule) => Rule.max(6),
      of: [
        {
          type: 'object',
          fields: [
            {name: 'title', title: 'Game Title', type: 'string'},
            {
              name: 'coverImage',
              title: 'Cover Image',
              type: 'image',
              options: {hotspot: true},
            },
          ],
        },
      ],
    },
    {
      name: 'moreGames',
      title: 'More Games',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {name: 'title', title: 'Game Title', type: 'string'},
            {
              name: 'coverImage',
              title: 'Cover Image',
              type: 'image',
              options: {hotspot: true},
            },
          ],
        },
      ],
    },
  ],
}
