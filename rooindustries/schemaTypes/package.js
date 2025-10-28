export default {
  name: 'package',
  title: 'Packages',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Package Title',
      type: 'string',
      description: 'e.g. Performance Vertex Overhaul, XOC / Extreme Overclocking',
    },
    {
      name: 'price',
      title: 'Price',
      type: 'string',
      description: 'Displayed as text, e.g. $79.99 or $199.99',
    },
    {
      name: 'tag',
      title: 'Highlight Tag',
      type: 'string',
      description: "Optional label like 'Most Popular' (leave blank if none)",
    },
    {
      name: 'features',
      title: 'Package Features',
      type: 'array',
      of: [{type: 'string'}],
      description: "List of bullet points describing what's included",
    },
    {
      name: 'buttonText',
      title: 'Button Text',
      type: 'string',
      initialValue: 'Book Now',
    },
    {
      name: 'buttonLink',
      title: 'Button Link',
      type: 'string',
      description: 'Internal or external link (e.g. /discord or https://...)',
    },
    {
      name: 'isHighlighted',
      title: 'Highlight Card',
      type: 'boolean',
      description: "If true, adds glow & 'most popular' look.",
      initialValue: false,
    },
  ],
}
