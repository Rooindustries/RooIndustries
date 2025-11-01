export default {
  name: 'reviewsCarousel',
  title: 'Reviews Carousel',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Section Title',
      type: 'string',
      description: "Heading at the top of the reviews section (e.g. 'What People Say')",
    },
    {
      name: 'subtitle',
      title: 'Subtitle',
      type: 'string',
      description: "Short description below the title (e.g. 'Feedback from clients...')",
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
