export default {
  name: 'contact',
  title: 'Contact Section',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Heading',
      type: 'string',
      initialValue: 'Get In Touch',
    },
    {
      name: 'subtitle',
      title: 'Subtitle',
      type: 'text',
      rows: 3,
      initialValue:
        "Ready to optimize your PC? Let's discuss how I can help improve your system's performance.",
    },
    {
      name: 'email',
      title: 'Contact Email',
      type: 'string',
      initialValue: 'serviroo@rooindustries.com',
    },
    {
      name: 'formId',
      title: 'Formspree Form ID',
      type: 'string',
      initialValue: 'mpwybpen',
    },
  ],
}
