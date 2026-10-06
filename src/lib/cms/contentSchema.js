import { UPGRADE_LINK_SLUG_PATTERN } from "../globalCmsContract.js";

const definitions = [
  {
    "name": "about",
    "title": "About Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "recordTitle",
        "title": "Record Title",
        "type": "string",
        "initialValue": "3DMark Hall of Fame"
      },
      {
        "name": "recordBadgeText",
        "title": "Record Badge Text",
        "type": "string",
        "initialValue": "Proof"
      },
      {
        "name": "recordSubtitle",
        "title": "Record Subtitle",
        "type": "string",
        "initialValue": "CPU Profile Global Hall of Fame - Official Entry"
      },
      {
        "name": "recordButtonText",
        "title": "Record Button Text",
        "type": "string",
        "initialValue": "See Official Leaderboard"
      },
      {
        "name": "recordNote",
        "title": "Record Note",
        "type": "string",
        "initialValue": "Former #16 global CPU profile"
      },
      {
        "name": "recordDetails",
        "title": "Record Details",
        "type": "array",
        "initialValue": [
          {
            "label": "RANK",
            "value": "#31",
            "sub": ""
          },
          {
            "label": "SCORE",
            "value": "18829",
            "sub": ""
          },
          {
            "label": "DATE",
            "value": "Jun 4, 2025",
            "sub": ""
          },
          {
            "label": "CPU",
            "value": "AMD Ryzen 9 9950X3D",
            "sub": ""
          },
          {
            "label": "GPU",
            "value": "NVIDIA GeForce RTX 5080",
            "sub": ""
          }
        ],
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "label",
                "title": "Label",
                "type": "string"
              },
              {
                "name": "value",
                "title": "Value",
                "type": "string"
              },
              {
                "name": "sub",
                "title": "Subtext",
                "type": "string"
              }
            ]
          }
        ]
      },
      {
        "name": "recordImage",
        "title": "Record Image",
        "type": "image",
        "options": {
          "hotspot": true
        }
      },
      {
        "name": "recordLink",
        "title": "Record Link",
        "type": "url",
        "schemes": [
          "http",
          "https"
        ]
      }
    ],
    "preview": {
      "title": "recordTitle"
    }
  },
  {
    "name": "benchmark",
    "title": "Benchmark",
    "group": "site",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Benchmark Name",
        "type": "string",
        "description": "Name of the benchmark"
      },
      {
        "name": "subtitle",
        "title": "Subtitle / Small Description",
        "type": "string",
        "description": "Short optional description under the title."
      },
      {
        "name": "sortOrder",
        "title": "Sort Order",
        "type": "number",
        "description": "Lower numbers appear first on the site (0, 1, 2, ...).",
        "initialValue": 0
      },
      {
        "name": "beforeImage",
        "title": "Before Image",
        "type": "image",
        "options": {
          "hotspot": true
        }
      },
      {
        "name": "afterImage",
        "title": "After Image",
        "type": "image",
        "options": {
          "hotspot": true
        }
      },
      {
        "name": "reviewImage",
        "title": "Review Image (Discord Screenshot)",
        "type": "image",
        "options": {
          "hotspot": true
        }
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "bookingSettings",
    "title": "Booking Settings",
    "group": "commerce",
    "singleton": true,
    "fields": [
      {
        "name": "maxDaysAheadBooking",
        "title": "Maximum Days Ahead Booking",
        "type": "number",
        "initialValue": 7
      },
      {
        "name": "ownerEmail",
        "title": "Booking Owner Email",
        "type": "string",
        "description": "Notification destination for new bookings. Overrides OWNER_EMAIL if set.",
        "email": true,
        "warning": "Enter a valid email address."
      },
      {
        "name": "packageDateSlots",
        "title": "Package Date Slots",
        "type": "array",
        "description": "Optional per-package date overrides. If set, these slots take priority for that package.",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "package",
                "title": "Package",
                "type": "reference",
                "to": [
                  "package"
                ]
              },
              {
                "name": "dateSlots",
                "title": "Date Slots",
                "type": "array",
                "of": [
                  {
                    "type": "object",
                    "fields": [
                      {
                        "name": "date",
                        "title": "Date",
                        "type": "date"
                      },
                      {
                        "name": "times",
                        "title": "Available Hours (24h)",
                        "type": "array",
                        "of": [
                          {
                            "type": "string"
                          }
                        ],
                        "options": {
                          "layout": "grid",
                          "list": [
                            {
                              "title": "0:00",
                              "value": "0"
                            },
                            {
                              "title": "1:00",
                              "value": "1"
                            },
                            {
                              "title": "2:00",
                              "value": "2"
                            },
                            {
                              "title": "3:00",
                              "value": "3"
                            },
                            {
                              "title": "4:00",
                              "value": "4"
                            },
                            {
                              "title": "5:00",
                              "value": "5"
                            },
                            {
                              "title": "6:00",
                              "value": "6"
                            },
                            {
                              "title": "7:00",
                              "value": "7"
                            },
                            {
                              "title": "8:00",
                              "value": "8"
                            },
                            {
                              "title": "9:00",
                              "value": "9"
                            },
                            {
                              "title": "10:00",
                              "value": "10"
                            },
                            {
                              "title": "11:00",
                              "value": "11"
                            },
                            {
                              "title": "12:00",
                              "value": "12"
                            },
                            {
                              "title": "13:00",
                              "value": "13"
                            },
                            {
                              "title": "14:00",
                              "value": "14"
                            },
                            {
                              "title": "15:00",
                              "value": "15"
                            },
                            {
                              "title": "16:00",
                              "value": "16"
                            },
                            {
                              "title": "17:00",
                              "value": "17"
                            },
                            {
                              "title": "18:00",
                              "value": "18"
                            },
                            {
                              "title": "19:00",
                              "value": "19"
                            },
                            {
                              "title": "20:00",
                              "value": "20"
                            },
                            {
                              "title": "21:00",
                              "value": "21"
                            },
                            {
                              "title": "22:00",
                              "value": "22"
                            },
                            {
                              "title": "23:00",
                              "value": "23"
                            }
                          ]
                        }
                      }
                    ]
                  }
                ]
              }
            ],
            "preview": {
              "title": "package.title"
            }
          }
        ]
      },
      {
        "name": "dateSlots",
        "title": "Date-Based Time Slots (Vertex / Default)",
        "type": "array",
        "description": "Add specific dates with available hours.",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "date",
                "title": "Date",
                "type": "date"
              },
              {
                "name": "times",
                "title": "Available Hours (24h)",
                "type": "array",
                "of": [
                  {
                    "type": "string"
                  }
                ],
                "options": {
                  "layout": "grid",
                  "list": [
                    {
                      "title": "0:00",
                      "value": "0"
                    },
                    {
                      "title": "1:00",
                      "value": "1"
                    },
                    {
                      "title": "2:00",
                      "value": "2"
                    },
                    {
                      "title": "3:00",
                      "value": "3"
                    },
                    {
                      "title": "4:00",
                      "value": "4"
                    },
                    {
                      "title": "5:00",
                      "value": "5"
                    },
                    {
                      "title": "6:00",
                      "value": "6"
                    },
                    {
                      "title": "7:00",
                      "value": "7"
                    },
                    {
                      "title": "8:00",
                      "value": "8"
                    },
                    {
                      "title": "9:00",
                      "value": "9"
                    },
                    {
                      "title": "10:00",
                      "value": "10"
                    },
                    {
                      "title": "11:00",
                      "value": "11"
                    },
                    {
                      "title": "12:00",
                      "value": "12"
                    },
                    {
                      "title": "13:00",
                      "value": "13"
                    },
                    {
                      "title": "14:00",
                      "value": "14"
                    },
                    {
                      "title": "15:00",
                      "value": "15"
                    },
                    {
                      "title": "16:00",
                      "value": "16"
                    },
                    {
                      "title": "17:00",
                      "value": "17"
                    },
                    {
                      "title": "18:00",
                      "value": "18"
                    },
                    {
                      "title": "19:00",
                      "value": "19"
                    },
                    {
                      "title": "20:00",
                      "value": "20"
                    },
                    {
                      "title": "21:00",
                      "value": "21"
                    },
                    {
                      "title": "22:00",
                      "value": "22"
                    },
                    {
                      "title": "23:00",
                      "value": "23"
                    }
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        "name": "vertexEssentialsDateSlots",
        "title": "Date-Based Time Slots (Vertex Essentials)",
        "type": "array",
        "description": "Add specific dates with available hours.",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "date",
                "title": "Date",
                "type": "date"
              },
              {
                "name": "times",
                "title": "Available Hours (24h)",
                "type": "array",
                "of": [
                  {
                    "type": "string"
                  }
                ],
                "options": {
                  "layout": "grid",
                  "list": [
                    {
                      "title": "0:00",
                      "value": "0"
                    },
                    {
                      "title": "1:00",
                      "value": "1"
                    },
                    {
                      "title": "2:00",
                      "value": "2"
                    },
                    {
                      "title": "3:00",
                      "value": "3"
                    },
                    {
                      "title": "4:00",
                      "value": "4"
                    },
                    {
                      "title": "5:00",
                      "value": "5"
                    },
                    {
                      "title": "6:00",
                      "value": "6"
                    },
                    {
                      "title": "7:00",
                      "value": "7"
                    },
                    {
                      "title": "8:00",
                      "value": "8"
                    },
                    {
                      "title": "9:00",
                      "value": "9"
                    },
                    {
                      "title": "10:00",
                      "value": "10"
                    },
                    {
                      "title": "11:00",
                      "value": "11"
                    },
                    {
                      "title": "12:00",
                      "value": "12"
                    },
                    {
                      "title": "13:00",
                      "value": "13"
                    },
                    {
                      "title": "14:00",
                      "value": "14"
                    },
                    {
                      "title": "15:00",
                      "value": "15"
                    },
                    {
                      "title": "16:00",
                      "value": "16"
                    },
                    {
                      "title": "17:00",
                      "value": "17"
                    },
                    {
                      "title": "18:00",
                      "value": "18"
                    },
                    {
                      "title": "19:00",
                      "value": "19"
                    },
                    {
                      "title": "20:00",
                      "value": "20"
                    },
                    {
                      "title": "21:00",
                      "value": "21"
                    },
                    {
                      "title": "22:00",
                      "value": "22"
                    },
                    {
                      "title": "23:00",
                      "value": "23"
                    }
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        "name": "xocDateSlots",
        "title": "Date-Based Time Slots (XOC / Extreme Overclocking)",
        "type": "array",
        "description": "Add specific dates with available hours.",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "date",
                "title": "Date",
                "type": "date"
              },
              {
                "name": "times",
                "title": "Available Hours (24h)",
                "type": "array",
                "of": [
                  {
                    "type": "string"
                  }
                ],
                "options": {
                  "layout": "grid",
                  "list": [
                    {
                      "title": "0:00",
                      "value": "0"
                    },
                    {
                      "title": "1:00",
                      "value": "1"
                    },
                    {
                      "title": "2:00",
                      "value": "2"
                    },
                    {
                      "title": "3:00",
                      "value": "3"
                    },
                    {
                      "title": "4:00",
                      "value": "4"
                    },
                    {
                      "title": "5:00",
                      "value": "5"
                    },
                    {
                      "title": "6:00",
                      "value": "6"
                    },
                    {
                      "title": "7:00",
                      "value": "7"
                    },
                    {
                      "title": "8:00",
                      "value": "8"
                    },
                    {
                      "title": "9:00",
                      "value": "9"
                    },
                    {
                      "title": "10:00",
                      "value": "10"
                    },
                    {
                      "title": "11:00",
                      "value": "11"
                    },
                    {
                      "title": "12:00",
                      "value": "12"
                    },
                    {
                      "title": "13:00",
                      "value": "13"
                    },
                    {
                      "title": "14:00",
                      "value": "14"
                    },
                    {
                      "title": "15:00",
                      "value": "15"
                    },
                    {
                      "title": "16:00",
                      "value": "16"
                    },
                    {
                      "title": "17:00",
                      "value": "17"
                    },
                    {
                      "title": "18:00",
                      "value": "18"
                    },
                    {
                      "title": "19:00",
                      "value": "19"
                    },
                    {
                      "title": "20:00",
                      "value": "20"
                    },
                    {
                      "title": "21:00",
                      "value": "21"
                    },
                    {
                      "title": "22:00",
                      "value": "22"
                    },
                    {
                      "title": "23:00",
                      "value": "23"
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": null
    },
    "fixedId": "6d8a3646-0ed2-44b5-ad45-c5c9d578126a"
  },
  {
    "name": "contact",
    "title": "Contact Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Heading",
        "type": "string",
        "initialValue": "Get In Touch"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "text",
        "rows": 3,
        "initialValue": "Ready to optimize your PC? Let's discuss how I can help improve your system's performance."
      },
      {
        "name": "email",
        "title": "Contact Email",
        "type": "string",
        "initialValue": "serviroo@rooindustries.com"
      },
      {
        "name": "formId",
        "title": "Formspree Form ID",
        "type": "string",
        "initialValue": "mpwybpen"
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "coupon",
    "title": "Coupons",
    "group": "commerce",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Coupon Name",
        "type": "string",
        "description": "Internal name, e.g. 'Black Friday 10% off'",
        "required": true
      },
      {
        "name": "code",
        "title": "Coupon Code",
        "type": "string",
        "description": "What customers type at checkout (case-insensitive, e.g. 'BF10')",
        "required": true,
        "min": 2,
        "max": 32,
        "customRule": "coupon.code"
      },
      {
        "name": "discountType",
        "title": "Discount Type",
        "type": "string",
        "description": "Percent off or a fixed USD amount off.",
        "initialValue": "percent",
        "options": {
          "list": [
            {
              "title": "Percent off",
              "value": "percent"
            },
            {
              "title": "Fixed USD off",
              "value": "fixed"
            }
          ],
          "layout": "radio"
        },
        "required": true
      },
      {
        "name": "discountPercent",
        "title": "Discount Percentage",
        "type": "number",
        "description": "How much discount this coupon gives (0–100)",
        "hiddenRule": "({parent}) => parent?.discountType === 'fixed'",
        "customRule": "coupon.discountPercent"
      },
      {
        "name": "discountAmount",
        "title": "Discount Amount (USD)",
        "type": "number",
        "description": "Fixed USD amount off the selected package.",
        "hiddenRule": "({parent}) => (parent?.discountType || 'percent') !== 'fixed'",
        "customRule": "coupon.discountAmount"
      },
      {
        "name": "eligiblePackages",
        "title": "Eligible Packages",
        "type": "array",
        "description": "Limit this coupon to selected packages. Leave empty to allow all packages.",
        "of": [
          {
            "type": "reference",
            "to": [
              "package"
            ]
          }
        ]
      },
      {
        "name": "isActive",
        "title": "Active",
        "type": "boolean",
        "description": "Turn coupon on/off",
        "initialValue": true
      },
      {
        "name": "canCombineWithReferral",
        "title": "Can be clubbed with referral discount?",
        "type": "boolean",
        "description": "If ON, this coupon can stack with referral discount. If OFF, user must choose referral OR coupon.",
        "initialValue": false
      },
      {
        "name": "validFrom",
        "title": "Valid From (optional)",
        "type": "datetime"
      },
      {
        "name": "validTo",
        "title": "Valid To (optional)",
        "type": "datetime"
      },
      {
        "name": "maxUses",
        "title": "Maximum Uses (optional)",
        "type": "number",
        "description": "Total number of times this coupon can be used. Leave empty for unlimited.",
        "min": 1,
        "warning": "Leave empty for unlimited uses."
      },
      {
        "name": "timesUsed",
        "title": "Times Used",
        "type": "number",
        "description": "How many times this coupon has been used (auto-updated).",
        "readOnly": true,
        "initialValue": 0
      },
      {
        "name": "activeReservations",
        "title": "Active Checkout Reservations",
        "type": "number",
        "readOnly": true,
        "initialValue": 0,
        "description": "Temporary reservations made before a provider order is exposed."
      },
      {
        "name": "autoDeactivatedByRedemptionId",
        "type": "string",
        "readOnly": true,
        "hidden": true
      },
      {
        "name": "autoDeactivatedAt",
        "type": "datetime",
        "readOnly": true,
        "hidden": true
      },
      {
        "name": "redemptionCount",
        "title": "Tracked Redemption Documents",
        "type": "number",
        "readOnly": true,
        "initialValue": 0
      },
      {
        "name": "notes",
        "title": "Notes",
        "type": "text",
        "rows": 3
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "discordBanner",
    "title": "Discord Banner",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "text",
        "title": "Banner Text",
        "type": "string",
        "initialValue": "Free optimization guide in our Discord"
      },
      {
        "name": "mobileText",
        "title": "Mobile Text",
        "type": "string",
        "initialValue": "Free guide in Discord"
      },
      {
        "name": "link",
        "title": "Link",
        "type": "url",
        "initialValue": "https://discord.com/invite/qs5HKNyazD",
        "schemes": [
          "http",
          "https"
        ]
      }
    ],
    "preview": {
      "title": null
    }
  },
  {
    "name": "faqSection",
    "title": "FAQ",
    "group": "site",
    "singleton": false,
    "fields": [
      {
        "name": "questions",
        "title": "Questions",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "question",
                "title": "Question",
                "type": "string"
              },
              {
                "name": "answer",
                "title": "Answer",
                "type": "text",
                "rows": 4
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": null
    }
  },
  {
    "name": "faqSettings",
    "title": "FAQ Settings",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "eyebrow",
        "title": "Eyebrow Text",
        "type": "string",
        "description": "Small label above the FAQ heading"
      },
      {
        "name": "title",
        "title": "Heading",
        "type": "string"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "text",
        "rows": 2,
        "description": "Short line under the heading"
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "footer",
    "title": "Footer Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Heading",
        "type": "string"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "string"
      },
      {
        "name": "description",
        "title": "Description",
        "type": "text",
        "rows": 3
      },
      {
        "name": "availability",
        "title": "Availability Text",
        "type": "string"
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "hero",
    "title": "Hero Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "tagline",
        "title": "Tagline",
        "type": "string"
      },
      {
        "name": "headingLine1",
        "title": "Main Heading (Line 1)",
        "type": "string"
      },
      {
        "name": "headingLine2",
        "title": "Main Heading (Line 2)",
        "type": "string"
      },
      {
        "name": "description",
        "title": "Short Description",
        "type": "text",
        "rows": 3
      },
      {
        "name": "subtext",
        "title": "Small Highlight Text",
        "type": "string"
      },
      {
        "name": "ctaPrimaryText",
        "title": "Primary CTA Text",
        "type": "string",
        "description": "Label for the Book Optimization button."
      },
      {
        "name": "ctaSecondaryText",
        "title": "Secondary CTA Text",
        "type": "string",
        "description": "Label for the See FPS Boosts button."
      },
      {
        "name": "ctaNote",
        "title": "CTA Note (Line under buttons)",
        "type": "string",
        "description": "Optional line shown under hero buttons, above badges."
      },
      {
        "name": "ctaNoteIcon",
        "title": "CTA Note Icon",
        "type": "string",
        "description": "Optional icon/emoji shown before the CTA note."
      },
      {
        "name": "bullets",
        "title": "Bottom Bullet Points",
        "type": "array",
        "of": [
          {
            "type": "string"
          }
        ]
      }
    ],
    "preview": {
      "title": null
    }
  },
  {
    "name": "howItWorks",
    "title": "How It Works Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Section Title",
        "type": "string"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "string"
      },
      {
        "name": "steps",
        "title": "Steps",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "badge",
                "title": "Step Badge",
                "type": "string"
              },
              {
                "name": "title",
                "title": "Step Title",
                "type": "string"
              },
              {
                "name": "text",
                "title": "Step Description",
                "type": "text"
              },
              {
                "name": "faqText",
                "title": "FAQ Link Text",
                "type": "string"
              },
              {
                "name": "faqLink",
                "title": "FAQ Link (e.g. /faq#trust)",
                "type": "string"
              },
              {
                "name": "iconType",
                "title": "Icon Type",
                "type": "string",
                "options": {
                  "list": [
                    {
                      "title": "Discord",
                      "value": "discord"
                    },
                    {
                      "title": "Download",
                      "value": "download"
                    },
                    {
                      "title": "Microchip",
                      "value": "microchip"
                    },
                    {
                      "title": "Windows",
                      "value": "windows"
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "meetTheTeam",
    "title": "Meet The Team Page",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "seoTitle",
        "title": "SEO Title",
        "type": "string"
      },
      {
        "name": "seoDescription",
        "title": "SEO Description",
        "type": "text"
      },
      {
        "name": "heroTitle",
        "title": "Hero Title",
        "type": "string"
      },
      {
        "name": "heroSubtitle",
        "title": "Hero Subtitle",
        "type": "string"
      },
      {
        "name": "showFounder",
        "title": "Show Founder Section",
        "type": "boolean",
        "initialValue": true
      },
      {
        "name": "founder",
        "title": "Founder Card",
        "type": "object",
        "fields": [
          {
            "name": "badgeText",
            "title": "Badge Text",
            "type": "string"
          },
          {
            "name": "name",
            "title": "Name",
            "type": "string"
          },
          {
            "name": "title",
            "title": "Title",
            "type": "string"
          },
          {
            "name": "bio",
            "title": "Bio",
            "type": "text"
          },
          {
            "name": "avatar",
            "title": "Avatar",
            "type": "image",
            "options": {
              "hotspot": true
            }
          },
          {
            "name": "stats",
            "title": "Stats",
            "type": "array",
            "of": [
              {
                "type": "object",
                "fields": [
                  {
                    "name": "value",
                    "title": "Value",
                    "type": "string"
                  },
                  {
                    "name": "label",
                    "title": "Label",
                    "type": "string"
                  }
                ]
              }
            ]
          },
          {
            "name": "tags",
            "title": "Tags",
            "type": "array",
            "of": [
              {
                "type": "string"
              }
            ]
          },
          {
            "name": "socialLinks",
            "title": "Social Links",
            "type": "array",
            "of": [
              {
                "type": "object",
                "fields": [
                  {
                    "name": "label",
                    "title": "Label",
                    "type": "string"
                  },
                  {
                    "name": "url",
                    "title": "URL",
                    "type": "url",
                    "schemes": [
                      "http",
                      "https"
                    ]
                  },
                  {
                    "name": "icon",
                    "title": "Icon",
                    "type": "string",
                    "options": {
                      "list": [
                        {
                          "title": "X (Twitter)",
                          "value": "x"
                        },
                        {
                          "title": "Twitch",
                          "value": "twitch"
                        },
                        {
                          "title": "Discord",
                          "value": "discord"
                        },
                        {
                          "title": "Link",
                          "value": "link"
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "name": "sections",
        "title": "Team Sections",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "title",
                "title": "Title",
                "type": "string"
              },
              {
                "name": "variant",
                "title": "Card Style",
                "type": "string",
                "options": {
                  "list": [
                    {
                      "title": "Standard",
                      "value": "standard"
                    },
                    {
                      "title": "Ambassador",
                      "value": "ambassador"
                    }
                  ]
                },
                "initialValue": "standard"
              },
              {
                "name": "cards",
                "title": "Cards",
                "type": "array",
                "of": [
                  {
                    "type": "object",
                    "fields": [
                      {
                        "name": "name",
                        "title": "Name",
                        "type": "string"
                      },
                      {
                        "name": "title",
                        "title": "Title",
                        "type": "string"
                      },
                      {
                        "name": "bio",
                        "title": "Bio",
                        "type": "text"
                      },
                      {
                        "name": "avatar",
                        "title": "Avatar",
                        "type": "image",
                        "options": {
                          "hotspot": true
                        }
                      },
                      {
                        "name": "initials",
                        "title": "Initials",
                        "type": "string",
                        "description": "Shown if no avatar image is provided."
                      },
                      {
                        "name": "tags",
                        "title": "Tags",
                        "type": "array",
                        "of": [
                          {
                            "type": "string"
                          }
                        ]
                      },
                      {
                        "name": "platformBadge",
                        "title": "Platform Badge",
                        "type": "string"
                      },
                      {
                        "name": "ctaLabel",
                        "title": "CTA Label",
                        "type": "string"
                      },
                      {
                        "name": "ctaUrl",
                        "title": "CTA URL",
                        "type": "url",
                        "schemes": [
                          "http",
                          "https"
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "name": "footer",
        "title": "Footer CTA",
        "type": "object",
        "fields": [
          {
            "name": "note",
            "title": "Note",
            "type": "string"
          },
          {
            "name": "buttonText",
            "title": "Button Text",
            "type": "string"
          },
          {
            "name": "buttonUrl",
            "title": "Button URL",
            "type": "url",
            "schemes": [
              "http",
              "https"
            ]
          },
          {
            "name": "showDiscordIcon",
            "title": "Show Discord Icon",
            "type": "boolean",
            "initialValue": true
          }
        ]
      }
    ],
    "preview": {
      "title": "heroTitle"
    }
  },
  {
    "name": "package",
    "title": "Packages",
    "group": "commerce",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Package Title",
        "type": "string",
        "description": "e.g. Performance Vertex Overhaul, XOC / Extreme Overclocking",
        "required": true
      },
      {
        "name": "price",
        "title": "Price",
        "type": "string",
        "description": "Displayed as text, e.g. $79.99 or $199.99",
        "required": true
      },
      {
        "name": "description",
        "title": "Short Description (shows under price)",
        "type": "text",
        "rows": 3,
        "description": "One or two lines that summarize the package."
      },
      {
        "name": "order",
        "title": "Display Order",
        "type": "number",
        "description": "Controls package ordering (1 renders leftmost)",
        "initialValue": 1,
        "integer": true,
        "min": 1
      },
      {
        "name": "tag",
        "title": "Highlight Tag",
        "type": "string",
        "description": "Optional label like 'Most Popular' (leave blank if none)"
      },
      {
        "name": "tagGoldGlow",
        "title": "Highlight Tag Gold Glow",
        "type": "boolean",
        "description": "Uses the gold glow styling for the highlight tag.",
        "initialValue": false
      },
      {
        "name": "checkedBullets",
        "title": "Checked Bullet Points",
        "type": "array",
        "of": [
          {
            "type": "string"
          }
        ],
        "description": "Bullet points shown as checked for this package.",
        "unique": true
      },
      {
        "name": "uncheckedBullets",
        "title": "Unchecked Bullet Points",
        "type": "array",
        "of": [
          {
            "type": "string"
          }
        ],
        "description": "Bullet points shown as unchecked for this package.",
        "unique": true
      },
      {
        "name": "features",
        "title": "Full Breakdown Features (Modal)",
        "type": "array",
        "of": [
          {
            "type": "string"
          }
        ],
        "description": "Detailed bullet points shown in Full Breakdown modal"
      },
      {
        "name": "buttonText",
        "title": "Button Text",
        "type": "string",
        "initialValue": "Book Now"
      },
      {
        "name": "detailsButtonText",
        "title": "Details Button Text",
        "type": "string",
        "description": "Label for the breakdown button on the packages page.",
        "initialValue": "See What's Included"
      },
      {
        "name": "isHighlighted",
        "title": "Highlight Card",
        "type": "boolean",
        "description": "If true, adds glow & 'most popular' look.",
        "initialValue": false
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "packagesSettings",
    "title": "Packages Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "heading",
        "title": "Heading",
        "type": "string",
        "description": "Main heading above the packages list."
      },
      {
        "name": "badgeText",
        "title": "Badge Text",
        "type": "string",
        "description": "Small pill text shown under the heading."
      },
      {
        "name": "subheading",
        "title": "Subheading",
        "type": "text",
        "rows": 2,
        "description": "Short line under the badge."
      },
      {
        "name": "dividerText",
        "title": "Divider Text",
        "type": "text",
        "rows": 3,
        "description": "Text shown above the glow divider under the packages list."
      }
    ],
    "preview": {
      "title": "heading"
    }
  },
  {
    "name": "privacyPolicy",
    "title": "Privacy Policy Page",
    "group": "policies",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Page Title",
        "type": "string"
      },
      {
        "name": "sections",
        "title": "Sections",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "heading",
                "title": "Heading",
                "type": "string"
              },
              {
                "name": "content",
                "title": "Content",
                "type": "array",
                "of": [
                  {
                    "type": "block",
                    "styles": [
                      "normal",
                      "h1",
                      "h2",
                      "h3",
                      "h4",
                      "h5",
                      "h6",
                      "blockquote"
                    ],
                    "lists": [
                      "bullet",
                      "number"
                    ],
                    "decorators": [
                      "strong",
                      "em",
                      "code",
                      "underline",
                      "strike-through"
                    ],
                    "annotations": [
                      {
                        "name": "link",
                        "type": "object",
                        "fields": [
                          {
                            "name": "href",
                            "title": "URL",
                            "type": "url",
                            "schemes": [
                              "http",
                              "https",
                              "mailto",
                              "tel"
                            ],
                            "allowRelative": true
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "name": "lastUpdated",
        "title": "Last Updated",
        "type": "string"
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "proReviewsCarousel",
    "title": "Pro Reviews Carousel",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Section Title",
        "type": "string"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "string"
      },
      {
        "name": "reviews",
        "title": "Reviews",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "pfp",
                "title": "Profile Picture",
                "type": "image",
                "options": {
                  "hotspot": true
                }
              },
              {
                "name": "isVip",
                "title": "VIP Glow Effect",
                "type": "boolean",
                "description": "Enable for important creators. Adds a golden border and glow.",
                "initialValue": false
              },
              {
                "name": "name",
                "title": "Reviewer Name",
                "type": "string",
                "required": true
              },
              {
                "name": "profession",
                "title": "Profession",
                "type": "string"
              },
              {
                "name": "game",
                "title": "Game",
                "type": "string",
                "description": "Shown above the FPS result."
              },
              {
                "name": "optimizationResult",
                "title": "Optimization Result",
                "type": "string",
                "description": "e.g. \"200 -> 1000\" or \"FPS Boosted\""
              },
              {
                "name": "text",
                "title": "Review Text",
                "type": "text",
                "description": "Make sure to check if it fits well in the cards, some can fit differently even when same size.",
                "required": true,
                "max": 290
              },
              {
                "name": "rating",
                "title": "Star Rating",
                "type": "number",
                "options": {
                  "list": [
                    {
                      "title": "1 Star",
                      "value": 1
                    },
                    {
                      "title": "2 Stars",
                      "value": 2
                    },
                    {
                      "title": "3 Stars",
                      "value": 3
                    },
                    {
                      "title": "4 Stars",
                      "value": 4
                    },
                    {
                      "title": "5 Stars",
                      "value": 5
                    }
                  ]
                }
              }
            ],
            "preview": {
              "title": "name",
              "subtitle": "profession",
              "media": "pfp"
            }
          }
        ]
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "referralBox",
    "title": "Referral Box",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "heading",
        "title": "Heading",
        "type": "string",
        "required": true
      },
      {
        "name": "description",
        "title": "Description",
        "type": "text",
        "rows": 3
      },
      {
        "name": "emailPlaceholder",
        "title": "Email Placeholder",
        "type": "string",
        "initialValue": "Enter your email..."
      },
      {
        "name": "startButtonText",
        "title": "Get Started Button Text",
        "type": "string",
        "initialValue": "Get Started"
      },
      {
        "name": "loginButtonText",
        "title": "Login Button Text",
        "type": "string",
        "initialValue": "Login"
      },
      {
        "name": "registerPath",
        "title": "Register Path",
        "type": "string",
        "initialValue": "/referrals/register"
      },
      {
        "name": "loginPath",
        "title": "Login Path",
        "type": "string",
        "initialValue": "/login"
      }
    ],
    "preview": {
      "title": "heading"
    },
    "previewRule": "prepare({title}) {\n      return {title: title || 'Referral Box'}\n    }"
  },
  {
    "name": "review",
    "title": "Reviews",
    "group": "site",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Title",
        "type": "string"
      },
      {
        "name": "image",
        "title": "Review Image",
        "type": "image",
        "options": {
          "hotspot": true
        }
      },
      {
        "name": "alt",
        "title": "Alt Text",
        "type": "string"
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "services",
    "title": "Services Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "heading",
        "title": "Heading",
        "type": "string"
      },
      {
        "name": "subheading",
        "title": "Subheading",
        "type": "string"
      },
      {
        "name": "cards",
        "title": "Top Service Cards",
        "type": "array",
        "initialValue": [
          {
            "title": "Zero Lag",
            "description": "Click. It happens. No delay in between.",
            "iconType": "clock"
          },
          {
            "title": "Stutter Free",
            "description": "Consistent frametimes across the board.",
            "iconType": "zap"
          },
          {
            "title": "FPS Unlocked",
            "description": "You had more headroom than you thought.",
            "iconType": "shield"
          },
          {
            "title": "Deep Scan",
            "description": "Shows you the actual bottleneck, not a guess.",
            "iconType": "wrench"
          },
          {
            "title": "Go Live",
            "description": "OBS and your game stop competing for CPU.",
            "iconType": "video"
          },
          {
            "title": "No Throttle",
            "description": "Stays fast through long renders and edits.",
            "iconType": "cpu"
          }
        ],
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "title",
                "title": "Title",
                "type": "string"
              },
              {
                "name": "description",
                "title": "Description",
                "type": "text"
              },
              {
                "name": "iconType",
                "title": "Icon (Preset)",
                "type": "string",
                "description": "Select a built-in icon OR upload a custom one below.",
                "options": {
                  "list": [
                    {
                      "title": "Zap (Lightning)",
                      "value": "zap"
                    },
                    {
                      "title": "Clock (Time)",
                      "value": "clock"
                    },
                    {
                      "title": "Shield (Security)",
                      "value": "shield"
                    },
                    {
                      "title": "Wrench (Tools)",
                      "value": "wrench"
                    },
                    {
                      "title": "Video (Camera)",
                      "value": "video"
                    },
                    {
                      "title": "CPU (Processor)",
                      "value": "cpu"
                    }
                  ]
                }
              },
              {
                "name": "customIcon",
                "title": "Custom Icon (Upload)",
                "type": "image",
                "description": "Upload an SVG or PNG. This overrides the preset icon selection.",
                "options": {
                  "hotspot": true
                }
              }
            ]
          }
        ]
      },
      {
        "name": "benchMetricLabel",
        "title": "Default Metric Badge",
        "type": "string",
        "description": "Fallback badge if a game does not set its own (e.g., Avg FPS or 1% Lows).",
        "initialValue": "Avg FPS"
      },
      {
        "name": "benchBeforeLabel",
        "title": "Before Label",
        "type": "string",
        "initialValue": "Before"
      },
      {
        "name": "benchAfterLabel",
        "title": "Optimized Label",
        "type": "string",
        "initialValue": "Optimized"
      },
      {
        "name": "benchBadgeSuffix",
        "title": "Badge Suffix",
        "type": "string",
        "description": "Suffix for the percent badge (e.g., FPS).",
        "initialValue": "FPS"
      },
      {
        "name": "benchPagePrefix",
        "title": "Page Prefix",
        "type": "string",
        "initialValue": "Page"
      },
      {
        "name": "benchPages",
        "title": "Bench Pages",
        "type": "array",
        "of": [
          {
            "type": "object",
            "name": "benchPage",
            "fields": [
              {
                "name": "games",
                "title": "Games (3 per page recommended)",
                "type": "array",
                "of": [
                  {
                    "type": "object",
                    "name": "benchGame",
                    "fields": [
                      {
                        "name": "gameTitle",
                        "title": "Game Title",
                        "type": "string"
                      },
                      {
                        "name": "gameLogo",
                        "title": "Game Logo",
                        "type": "image",
                        "options": {
                          "hotspot": true
                        }
                      },
                      {
                        "name": "beforeFps",
                        "title": "Before FPS",
                        "type": "number"
                      },
                      {
                        "name": "afterFps",
                        "title": "Optimized FPS",
                        "type": "number"
                      },
                      {
                        "name": "metricLabel",
                        "title": "Avg/low Badge",
                        "type": "string",
                        "description": "Shown under the game name",
                        "initialValue": "Avg FPS"
                      },
                      {
                        "name": "gpu",
                        "title": "GPU",
                        "type": "string"
                      },
                      {
                        "name": "cpu",
                        "title": "CPU",
                        "type": "string"
                      },
                      {
                        "name": "ram",
                        "title": "RAM",
                        "type": "string"
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": "heading"
    }
  },
  {
    "name": "siteSettings",
    "title": "Site Control",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "siteMode",
        "title": "Site Mode",
        "type": "string",
        "initialValue": "maintenance",
        "options": {
          "layout": "radio",
          "direction": "horizontal",
          "list": [
            {
              "title": "Site Maintenance",
              "value": "maintenance"
            },
            {
              "title": "Site Live",
              "value": "live"
            }
          ]
        },
        "required": true
      }
    ],
    "preview": {
      "siteMode": "siteMode"
    },
    "previewRule": "({siteMode}) => ({\n      title: 'Site Control',\n      subtitle: siteMode === 'live' ? 'Site Live' : 'Site Maintenance',\n    })"
  },
  {
    "name": "supportedGames",
    "title": "Supported Games Section",
    "group": "site",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Title",
        "type": "string",
        "initialValue": "Supported Games"
      },
      {
        "name": "subtitle",
        "title": "Subtitle",
        "type": "string"
      },
      {
        "name": "showAllLabel",
        "title": "Show All Button Label",
        "type": "string",
        "initialValue": "Show All"
      },
      {
        "name": "showLessLabel",
        "title": "Show Less Button Label",
        "type": "string",
        "initialValue": "Show Less"
      },
      {
        "name": "featuredGames",
        "title": "Featured Games (max 6)",
        "type": "array",
        "max": 6,
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "title",
                "title": "Game Title",
                "type": "string"
              },
              {
                "name": "coverImage",
                "title": "Cover Image",
                "type": "image",
                "options": {
                  "hotspot": true
                }
              }
            ]
          }
        ]
      },
      {
        "name": "moreGames",
        "title": "More Games",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "title",
                "title": "Game Title",
                "type": "string"
              },
              {
                "name": "coverImage",
                "title": "Cover Image",
                "type": "image",
                "options": {
                  "hotspot": true
                }
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "terms",
    "title": "Terms and Conditions",
    "group": "policies",
    "singleton": true,
    "fields": [
      {
        "name": "title",
        "title": "Main Title",
        "type": "string"
      },
      {
        "name": "lastUpdated",
        "title": "Last Updated",
        "type": "string"
      },
      {
        "name": "sections",
        "title": "Sections",
        "type": "array",
        "of": [
          {
            "type": "object",
            "fields": [
              {
                "name": "heading",
                "title": "Section Heading",
                "type": "string"
              },
              {
                "name": "content",
                "title": "Content",
                "type": "array",
                "of": [
                  {
                    "type": "block",
                    "styles": [
                      "normal",
                      "h1",
                      "h2",
                      "h3",
                      "h4",
                      "h5",
                      "h6",
                      "blockquote"
                    ],
                    "lists": [
                      "bullet",
                      "number"
                    ],
                    "decorators": [
                      "strong",
                      "em",
                      "code",
                      "underline",
                      "strike-through"
                    ],
                    "annotations": [
                      {
                        "name": "link",
                        "type": "object",
                        "fields": [
                          {
                            "name": "href",
                            "title": "URL",
                            "type": "url",
                            "schemes": [
                              "http",
                              "https",
                              "mailto",
                              "tel"
                            ],
                            "allowRelative": true
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "tool",
    "title": "Tool",
    "group": "site",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Tool Name",
        "type": "string",
        "required": true
      },
      {
        "name": "sortOrder",
        "title": "Sort Order",
        "type": "number",
        "description": "Lower number = appears earlier in the list"
      },
      {
        "name": "category",
        "title": "Category",
        "type": "string",
        "description": "Type any label you want (e.g. Monitoring, Benchmarks, Overclocking, RAM, BIOS, etc.)"
      },
      {
        "name": "shortDescription",
        "title": "Short Description",
        "type": "text",
        "rows": 3,
        "description": "A brief line about what this tool is used for."
      },
      {
        "name": "icon",
        "title": "Icon",
        "type": "image",
        "options": {
          "hotspot": true
        },
        "description": "Small square logo for the card."
      },
      {
        "name": "downloadMode",
        "title": "Download Mode",
        "type": "string",
        "options": {
          "list": [
            {
              "title": "Official / External link",
              "value": "external"
            },
            {
              "title": "Hosted file on Roo",
              "value": "hosted"
            }
          ],
          "layout": "radio"
        },
        "initialValue": "external",
        "required": true
      },
      {
        "name": "downloadUrl",
        "title": "External Download URL",
        "type": "url",
        "description": "Used when mode = external (e.g. CPUID download link).",
        "hiddenRule": "({parent}) => parent?.downloadMode !== 'external'",
        "customRule": "tool.downloadUrl",
        "schemes": [
          "http",
          "https"
        ]
      },
      {
        "name": "downloadFile",
        "title": "Hosted Installer / ZIP",
        "type": "file",
        "description": "Upload the installer if you want to serve it directly from Roo (used when mode = hosted).",
        "hiddenRule": "({parent}) => parent?.downloadMode !== 'hosted'",
        "customRule": "tool.downloadFile"
      },
      {
        "name": "officialSite",
        "title": "Official Website",
        "type": "url",
        "description": "Main site for the tool, if you want a separate Official Site button.",
        "schemes": [
          "http",
          "https"
        ]
      },
      {
        "name": "downloadNote",
        "title": "Download Note",
        "type": "string",
        "description": "e.g.\"Download from official CPUID mirror\" or \"Installer hosted directly by Roo Industries.\""
      }
    ],
    "preview": {
      "title": "title"
    }
  },
  {
    "name": "upgradeLink",
    "title": "Upgrade Links",
    "group": "commerce",
    "singleton": false,
    "fields": [
      {
        "name": "title",
        "title": "Link Title",
        "type": "string",
        "description": "Shown as the page heading.",
        "required": true
      },
      {
        "name": "slug",
        "title": "Link Slug",
        "type": "slug",
        "options": {
          "source": "title"
        },
        "description": "Use in URL: rooindustries/upgrade/<link that you put in the field down here>",
        "required": true
      },
      {
        "name": "targetPackage",
        "title": "Upgrade To Package",
        "type": "reference",
        "to": [
          "package"
        ],
        "required": true
      },
      {
        "name": "intro",
        "title": "Short Intro Text",
        "type": "text",
        "rows": 3,
        "description": "short line shown under the heading if u want."
      }
    ],
    "preview": {
      "title": "title",
      "packageTitle": "targetPackage.title",
      "slug": "slug.current"
    },
    "previewRule": "prepare({title, packageTitle, slug}) {\n      return {\n        title: title || 'Upgrade Link',\n        subtitle: [packageTitle, slug ? `/${slug}` : ''].filter(Boolean).join(' - '),\n      }\n    }"
  }
];

export const CONTENT_TYPES = Object.freeze(definitions);

export const PORTABLE_TEXT_DEFAULTS = Object.freeze({
  styles: ["normal", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"],
  lists: ["bullet", "number"],
  decorators: ["strong", "em", "code", "underline", "strike-through"],
});

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, (_, item) => plainObject(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);
const systemFields = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_createdBy", "_originalId", "_system"]);
const keyPattern = /^[A-Za-z0-9_-]{1,128}$/;
const refPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/;
const hasValue = value => value !== undefined && value !== null && value !== "";
const validUrl = (value, schemes, relative = false) => {
  if (typeof value !== "string" || value.trim() !== value) return false;
  if (relative && /^\/(?!\/)/.test(value)) return true;
  try { const url = new URL(value); return schemes.includes(url.protocol.slice(0, -1)) && !url.username && !url.password; } catch { return false; }
};

export const isValidPublishLink = value => validUrl(value, ["http", "https", "mailto", "tel"], true);

export const validateContentDocument = (typeName, document, { current } = {}) => {
  const errors = [];
  const fail = (path, message) => { if (errors.length < 100) errors.push({ path, message }); };
  const schema = CONTENT_TYPES.find(type => type.name === typeName);
  if (!schema || !plainObject(document)) return { ok: false, errors: [{ path: "$", message: "A supported content document is required." }] };
  let nodes = 0;
  const bound = (value, path, depth = 0) => {
    if (++nodes > 50000 || depth > 20) { fail(path, "Content exceeds the structural limit."); return; }
    if (typeof value === "string" && value.length > 100000) fail(path, "Text exceeds the content limit.");
    if (typeof value === "number" && !Number.isFinite(value)) fail(path, "A finite number is required.");
    if (Array.isArray(value)) {
      if (value.length > 1000) { fail(path, "At most 1000 items are allowed."); return; }
      value.forEach((item, i) => bound(item, `${path}[${i}]`, depth + 1));
    } else if (plainObject(value)) {
      Object.entries(value).forEach(([key, item]) => {
        if (["__proto__", "constructor", "prototype"].includes(key)) fail(`${path}.${key}`, "Reserved field.");
        bound(item, `${path}.${key}`, depth + 1);
      });
    } else if (value !== null && !["undefined", "string", "number", "boolean"].includes(typeof value)) fail(path, "A JSON value is required.");
  };
  bound(document, "$");
  if (errors.length) return { ok: false, errors };
  if (canonical(document).length > 1000000) return { ok: false, errors: [{ path: "$", message: "Document exceeds 1 MB." }] };
  const unknown = (value, known, previous, path, root = false) => {
    for (const key of Object.keys(value)) {
      if (known.has(key) || (root && (systemFields.has(key) || key.startsWith("_supabase"))) || (!root && ["_key", "_type"].includes(key))) continue;
      if (!previous || !Object.hasOwn(previous, key) || !equal(previous[key], value[key])) fail(`${path}.${key}`, "Unknown fields may only retain their stored value.");
    }
  };
  const keyed = (value, previous, path) => {
    if (value._key !== undefined && (typeof value._key !== "string" || !keyPattern.test(value._key))) fail(`${path}._key`, "A valid item key is required.");
    if (!value._key && !equal(value, previous)) fail(`${path}._key`, "New object items require a stable key.");
  };
  const object = (fields, value, previous, path, root = false) => {
    unknown(value, new Set(fields.map(field => field.name)), previous, path, root);
    fields.forEach(field => validate(field, value[field.name], previous?.[field.name], `${path}.${field.name}`, value));
  };
  const reference = (value, previous, path, kind) => {
    if (!plainObject(value) || typeof value._ref !== "string" || !refPattern.test(value._ref) || /^(drafts|versions)\./.test(value._ref)) { fail(path, "A published document reference is required."); return; }
    if (kind && !value._ref.startsWith(`${kind}-`)) fail(`${path}._ref`, `A ${kind} asset reference is required.`);
    if (value._type !== undefined && value._type !== "reference") fail(`${path}._type`, "Reference type must be reference.");
    unknown(value, new Set(["_ref", "_weak"]), previous, path);
    if (value._weak !== undefined && typeof value._weak !== "boolean") fail(`${path}._weak`, "Weak reference flag must be boolean.");
  };
  const block = (value, previous, path) => {
    if (!plainObject(value) || value._type !== "block") { fail(path, "A Portable Text block is required."); return; }
    unknown(value, new Set(["style", "listItem", "level", "children", "markDefs"]), previous, path);
    if (value.style !== undefined && !PORTABLE_TEXT_DEFAULTS.styles.includes(value.style)) fail(`${path}.style`, "Unsupported block style.");
    if (value.listItem !== undefined && !PORTABLE_TEXT_DEFAULTS.lists.includes(value.listItem)) fail(`${path}.listItem`, "Unsupported list type.");
    if (value.level !== undefined && (!Number.isInteger(value.level) || value.level < 1 || value.level > 10)) fail(`${path}.level`, "List level must be 1 to 10.");
    if (!Array.isArray(value.children) || !Array.isArray(value.markDefs)) { fail(path, "Block children and markDefs must be arrays."); return; }
    const definitionKeys = new Set();
    value.markDefs.forEach((mark, i) => {
      const p = `${path}.markDefs[${i}]`;
      if (!plainObject(mark)) { fail(p, "A link annotation is required."); return; }
      keyed(mark, previous?.markDefs?.find(x => x._key === mark._key), p);
      if (definitionKeys.has(mark._key)) fail(p, "Annotation keys must be unique.");
      definitionKeys.add(mark._key);
      unknown(mark, new Set(["href"]), previous?.markDefs?.find(x => x._key === mark._key), p);
      if (mark._type !== "link" || !isValidPublishLink(mark.href)) fail(p, "A link with a supported URL is required.");
    });
    const childKeys = new Set();
    value.children.forEach((span, i) => {
      const p = `${path}.children[${i}]`;
      if (!plainObject(span)) { fail(p, "A text span is required."); return; }
      const prior = previous?.children?.find(x => x._key === span._key);
      keyed(span, prior, p);
      if (childKeys.has(span._key)) fail(p, "Span keys must be unique.");
      childKeys.add(span._key);
      unknown(span, new Set(["text", "marks"]), prior, p);
      if (span._type !== "span" || typeof span.text !== "string" || !Array.isArray(span.marks) || span.marks.some(mark => !PORTABLE_TEXT_DEFAULTS.decorators.includes(mark) && !definitionKeys.has(mark))) fail(p, "A span with valid text and marks is required.");
    });
  };
  const validate = (field, value, previous, path, parent) => {
    if (field.readOnly) return;
    if (field.required && !hasValue(value)) fail(path, "This field is required.");
    if (field.customRule === "tool.downloadUrl" && parent.downloadMode === "external" && !value) fail(path, "An external download URL is required.");
    if (field.customRule === "tool.downloadFile" && parent.downloadMode === "hosted" && !value) fail(path, "A hosted download file is required.");
    if (field.customRule === "coupon.discountPercent" && (parent.discountType || "percent") === "percent" && (typeof value !== "number" || value < 0 || value > 100)) fail(path, "Percent coupons require a percentage from 0 to 100.");
    if (field.customRule === "coupon.discountAmount" && parent.discountType === "fixed" && (typeof value !== "number" || value <= 0)) fail(path, "Fixed coupons require a positive amount.");
    if (!hasValue(value)) return;
    const type = field.type;
    if (["string", "text", "url", "email", "date", "datetime"].includes(type) && typeof value !== "string") { fail(path, "Text is required."); return; }
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) { fail(path, "A finite number is required."); return; }
    if (type === "boolean" && typeof value !== "boolean") fail(path, "A boolean is required.");
    const measure = typeof value === "number" ? value : value.length;
    if (field.min !== undefined && measure < field.min) fail(path, `Minimum is ${field.min}.`);
    if (field.max !== undefined && measure > field.max) fail(path, `Maximum is ${field.max}.`);
    if (field.integer && !Number.isInteger(value)) fail(path, "An integer is required.");
    if ((type === "email" || field.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(path, "A valid email is required.");
    if (type === "url" && !validUrl(value, field.schemes || ["http", "https"])) fail(path, "An absolute HTTP or HTTPS URL is required.");
    if (type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail(path, "A valid ISO date is required.");
    if (type === "datetime" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value)))) fail(path, "A valid ISO datetime is required.");
    if (field.options?.list && type !== "array" && !field.options.list.some(option => (option.value ?? option) === value)) fail(path, "Choose a listed option.");
    if (type === "slug") {
      if (!plainObject(value) || typeof value.current !== "string" || !UPGRADE_LINK_SLUG_PATTERN.test(value.current)) fail(path, "Use 1 to 80 letters, numbers or hyphens for the URL slug.");
      else unknown(value, new Set(["current"]), previous, path);
    }
    if (type === "reference") reference(value, previous, path);
    if (["image", "file"].includes(type)) {
      if (!plainObject(value) || !value.asset) { fail(path, "An asset is required."); return; }
      unknown(value, new Set(["asset", "crop", "hotspot"]), previous, path);
      reference(value.asset, previous?.asset, `${path}.asset`, type);
      for (const name of ["crop", "hotspot"]) if (value[name] !== undefined) {
        const keys = name === "crop" ? ["top", "bottom", "left", "right"] : ["x", "y", "width", "height"];
        if (!plainObject(value[name])) { fail(`${path}.${name}`, "An image geometry object is required."); continue; }
        unknown(value[name], new Set(keys), previous?.[name], `${path}.${name}`);
        keys.forEach(key => { const n = value[name][key]; if (typeof n !== "number" || n < 0 || n > 1) fail(`${path}.${name}.${key}`, "Image geometry must be 0 to 1."); });
      }
    }
    if (type === "object") {
      if (!plainObject(value)) fail(path, "An object is required.");
      else object(field.fields || [], value, previous, path);
    }
    if (type === "array") {
      if (!Array.isArray(value)) { fail(path, "An array is required."); return; }
      if (field.unique && new Set(value.map(canonical)).size !== value.length) fail(path, "Items must be unique.");
      const keys = new Set();
      value.forEach((item, i) => {
        const p = `${path}[${i}]`;
        const prior = plainObject(item) && item._key ? previous?.find?.(x => x?._key === item._key) : previous?.[i];
        if (plainObject(item)) { keyed(item, prior, p); if (item._key && keys.has(item._key)) fail(p, "Item keys must be unique."); keys.add(item._key); }
        if (field.options?.list && !field.options.list.some(option => (option.value ?? option) === item)) fail(p, "Choose a listed option.");
        const candidate = (field.of || []).find(f => f.type === item?._type || f.name === item?._type) || field.of?.[0];
        if (!candidate) { fail(p, "Unsupported array item."); return; }
        if (candidate.type === "block") block(item, prior, p);
        else validate(candidate, item, prior, p, parent);
      });
    }
  };
  object(schema.fields, document, current, "$", true);
  if (document._type !== undefined && document._type !== typeName) fail("$._type", "Document type does not match.");
  if (typeName === "package") {
    const price = typeof document.price === "string" ? document.price.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").trim() : "";
    if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(price) || !Number.isFinite(Number(price)) || Number(Number(price).toFixed(2)) <= 0) fail("$.price", "Price must parse to a positive amount.");
  }
  return { ok: errors.length === 0, errors };
};

export const CMS_SERVER_VALIDATIONS = Object.freeze(["couponReferralCodeNamespace", "packageLookupNamespace", "liveReferenceTargets", "inboundReferences", "singletons", "verifiedAssets", "couponOperationalFields"]);
export const createContentDefaults = (typeName) => {
  const schema = CONTENT_TYPES.find(type => type.name === typeName);
  const defaults = fields => Object.fromEntries(fields.filter(field => field.initialValue !== undefined).map(field => [field.name, JSON.parse(JSON.stringify(field.initialValue))]));
  return schema ? defaults(schema.fields) : {};
};
