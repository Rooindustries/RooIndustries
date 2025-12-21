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
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'price',
      title: 'Price',
      type: 'string',
      description: 'Displayed as text, e.g. $79.99 or $199.99',
      validation: (Rule) => Rule.required(),
    },

    // ✅ NEW
    {
      name: 'description',
      title: 'Short Description (shows under price)',
      type: 'text',
      rows: 3,
      description: 'One or two lines that summarize the package.',
    },

    {
      name: 'order',
      title: 'Display Order',
      type: 'number',
      description: 'Controls package ordering (1 renders leftmost)',
      initialValue: 1,
      validation: (Rule) => Rule.integer().min(1),
    },
    {
      name: 'tag',
      title: 'Highlight Tag',
      type: 'string',
      description: "Optional label like 'Most Popular' (leave blank if none)",
    },
    // Per-package bullet lists
    {
      name: 'checkedBullets',
      title: 'Checked Bullet Points',
      type: 'array',
      of: [{type: 'string'}],
      description: 'Bullet points shown as checked for this package.',
      validation: (Rule) => Rule.unique(),
    },
    {
      name: 'uncheckedBullets',
      title: 'Unchecked Bullet Points',
      type: 'array',
      of: [{type: 'string'}],
      description: 'Bullet points shown as unchecked for this package.',
      validation: (Rule) => Rule.unique(),
    },

    {
      name: 'features',
      title: 'Full Breakdown Features (Modal)',
      type: 'array',
      of: [{type: 'string'}],
      description: 'Detailed bullet points shown in Full Breakdown modal',
    },

    {
      name: 'buttonText',
      title: 'Button Text',
      type: 'string',
      initialValue: 'Book Now',
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
