export default {
  name: "meetTheTeam",
  title: "Meet The Team Page",
  type: "document",
  fields: [
    { name: "seoTitle", title: "SEO Title", type: "string" },
    { name: "seoDescription", title: "SEO Description", type: "text" },
    { name: "heroTitle", title: "Hero Title", type: "string" },
    { name: "heroSubtitle", title: "Hero Subtitle", type: "string" },
    {
      name: "showFounder",
      title: "Show Founder Section",
      type: "boolean",
      initialValue: true,
    },
    {
      name: "founder",
      title: "Founder Card",
      type: "object",
      fields: [
        { name: "badgeText", title: "Badge Text", type: "string" },
        { name: "name", title: "Name", type: "string" },
        { name: "title", title: "Title", type: "string" },
        { name: "bio", title: "Bio", type: "text" },
        {
          name: "avatar",
          title: "Avatar",
          type: "image",
          options: { hotspot: true },
        },
        {
          name: "stats",
          title: "Stats",
          type: "array",
          of: [
            {
              type: "object",
              fields: [
                { name: "value", title: "Value", type: "string" },
                { name: "label", title: "Label", type: "string" },
              ],
            },
          ],
        },
        {
          name: "tags",
          title: "Tags",
          type: "array",
          of: [{ type: "string" }],
        },
        {
          name: "socialLinks",
          title: "Social Links",
          type: "array",
          of: [
            {
              type: "object",
              fields: [
                { name: "label", title: "Label", type: "string" },
                { name: "url", title: "URL", type: "url" },
                {
                  name: "icon",
                  title: "Icon",
                  type: "string",
                  options: {
                    list: [
                      { title: "X (Twitter)", value: "x" },
                      { title: "Twitch", value: "twitch" },
                      { title: "Discord", value: "discord" },
                      { title: "Link", value: "link" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "sections",
      title: "Team Sections",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            { name: "title", title: "Title", type: "string" },
            {
              name: "variant",
              title: "Card Style",
              type: "string",
              options: {
                list: [
                  { title: "Standard", value: "standard" },
                  { title: "Ambassador", value: "ambassador" },
                ],
              },
              initialValue: "standard",
            },
            {
              name: "cards",
              title: "Cards",
              type: "array",
              of: [
                {
                  type: "object",
                  fields: [
                    { name: "name", title: "Name", type: "string" },
                    { name: "title", title: "Title", type: "string" },
                    { name: "bio", title: "Bio", type: "text" },
                    {
                      name: "avatar",
                      title: "Avatar",
                      type: "image",
                      options: { hotspot: true },
                    },
                    {
                      name: "initials",
                      title: "Initials",
                      type: "string",
                      description: "Shown if no avatar image is provided.",
                    },
                    {
                      name: "tags",
                      title: "Tags",
                      type: "array",
                      of: [{ type: "string" }],
                    },
                    {
                      name: "platformBadge",
                      title: "Platform Badge",
                      type: "string",
                    },
                    { name: "ctaLabel", title: "CTA Label", type: "string" },
                    { name: "ctaUrl", title: "CTA URL", type: "url" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "footer",
      title: "Footer CTA",
      type: "object",
      fields: [
        { name: "note", title: "Note", type: "string" },
        { name: "buttonText", title: "Button Text", type: "string" },
        { name: "buttonUrl", title: "Button URL", type: "url" },
        {
          name: "showDiscordIcon",
          title: "Show Discord Icon",
          type: "boolean",
          initialValue: true,
        },
      ],
    },
  ],
};
