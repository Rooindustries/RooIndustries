export default {
  name: 'proReviewsCarousel',
  title: 'Pro Reviews Carousel',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Section Title',
      type: 'string',
    },
    {
      name: 'subtitle',
      title: 'Subtitle',
      type: 'string',
    },
    {
      name: 'reviews',
      title: 'Reviews',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            {
              name: 'pfp',
              title: 'Profile Picture',
              type: 'image',
              options: {
                hotspot: true,
              },
            },
            {
              name: 'isVip',
              title: 'VIP Glow Effect',
              type: 'boolean',
              description: 'Enable for important creators. Adds a golden border and glow.',
              initialValue: false,
            },
            {
              name: 'name',
              title: 'Reviewer Name',
              type: 'string',
              validation: (Rule) => Rule.required(),
            },
            {
              name: 'profession',
              title: 'Profession',
              type: 'string',
            },
            {
              name: 'game',
              title: 'Game',
              type: 'string',
              description: 'Shown above the FPS result.',
            },
            {
              name: 'optimizationResult',
              title: 'Optimization Result',
              type: 'string',
              description: 'e.g. "200 -> 1000" or "FPS Boosted"',
            },
            {
              name: 'text',
              title: 'Review Text',
              type: 'text',
              description:
                'Make sure to check if it fits well in the cards, some can fit differently even when same size.',
              validation: (Rule) => Rule.required().max(290),
            },
            {
              name: 'rating',
              title: 'Star Rating',
              type: 'number',
              options: {
                list: [
                  {title: '1 Star', value: 1},
                  {title: '2 Stars', value: 2},
                  {title: '3 Stars', value: 3},
                  {title: '4 Stars', value: 4},
                  {title: '5 Stars', value: 5},
                ],
              },
            },
          ],
          preview: {
            select: {
              title: 'name',
              subtitle: 'profession',
              media: 'pfp',
            },
          },
        },
      ],
    },
  ],
}
