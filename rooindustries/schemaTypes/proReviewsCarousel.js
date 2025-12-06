export default {
  name: 'proReviewsCarousel',
  title: 'Pro Reviews Carousel',
  type: 'document',
  fields: [
    {
      name: 'slot',
      title: 'Placement Slot',
      type: 'string',
      description:
        'Select which column this carousel feeds (left or right). Create one doc per slot.',
      options: {
        list: [
          {title: 'Left', value: 'left'},
          {title: 'Right', value: 'right'},
        ],
        layout: 'radio',
      },
      initialValue: 'left',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'title',
      title: 'Section Title',
      type: 'string',
      description:
        "Heading at the top of the pro reviews section (e.g. 'What professional streamers and gamers say about us')",
    },
    {
      name: 'subtitle',
      title: 'Subtitle',
      type: 'string',
      description: "Short description below the title (e.g. 'Feedback from pros...')",
    },
    {
      name: 'glowEnabled',
      title: 'Enable Glow Animation',
      type: 'boolean',
      description: 'Toggle animated outline around this carousel.',
      initialValue: true,
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
              name: 'name',
              title: 'Reviewer Name',
              type: 'string',
            },
            {
              name: 'profession',
              title: 'Profession',
              type: 'string',
              description: 'e.g. Streamer, YouTuber, Coach, Analyst',
            },
            {
              name: 'text',
              title: 'Review Text',
              type: 'text',
            },
          ],
        },
      ],
    },
  ],
}
