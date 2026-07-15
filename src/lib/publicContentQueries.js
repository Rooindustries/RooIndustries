export const PUBLIC_CONTENT_QUERIES = Object.freeze({
  reviews: `*[_type == "proReviewsCarousel"][0]{
    _id,title,subtitle,
    reviews[]{name,profession,game,optimizationResult,text,rating,pfp,isVip}
  }`,
  about: `*[_type == "about"][0]{
    recordTitle,recordBadgeText,recordSubtitle,recordButtonText,
    recordNote,recordDetails,recordLink
  }`,
  services: `*[_type == "services"][0]{
    heading,subheading,cards[]{title,description,iconType,customIcon},
    benchEnabled,benchMetricLabel,benchBeforeLabel,benchAfterLabel,
    benchBadgeSuffix,benchPagePrefix,
    benchPages[]{games[]{gameTitle,gameLogo,beforeFps,afterFps,gpu,cpu,ram,metricLabel}}
  }`,
  "packages-list": `*[_type == "package"] | order(coalesce(order, 999) asc, _createdAt asc){
    _id,title,price,tag,tagGoldGlow,description,checkedBullets,uncheckedBullets,
    features,buttonText,detailsButtonText,isHighlighted,order
  }`,
  "packages-settings": `*[_type == "packagesSettings"][0]{
    heading,badgeText,subheading,dividerText
  }`,
  "how-it-works": `*[_type == "howItWorks"][0]{
    title,subtitle,steps[]{badge,title,text,iconType}
  }`,
  "supported-games": `*[_type == "supportedGames"][0]{
    title,subtitle,showAllLabel,showLessLabel,
    featuredGames[]{_key,title,coverImage{...,"dimensions":asset->metadata.dimensions}},
    moreGames[]{_key,title,coverImage{...,"dimensions":asset->metadata.dimensions}}
  }`,
  "faq-settings": `*[_type == "faqSettings"][0]{eyebrow,title,subtitle}`,
  "faq-questions": `coalesce(
    *[_type == "faqSection" && _id == "faq"][0].questions,
    *[_type == "faqSection"] | order(_createdAt asc).questions[]
  )`,
  hero: `*[_type == "hero"][0]{
    tagline,headingLine1,headingLine2,description,subtext,
    ctaPrimaryText,ctaSecondaryText,ctaNote,bullets
  }`,
  team: `*[_type == "meetTheTeam"][0]{
    seoTitle,seoDescription,heroTitle,heroSubtitle,showFounder,
    founder{badgeText,name,title,bio,avatar,stats[]{_key,value,label},tags,
      socialLinks[]{_key,label,url,icon}},
    sections[]{_key,title,variant,cards[]{_key,name,title,bio,avatar,initials,
      tags,platformBadge,ctaLabel,ctaUrl}},
    footer{note,buttonText,buttonUrl,showDiscordIcon}
  }`,
  contact: `*[_type == "contact"][0]{title,subtitle,email,formId}`,
  tools: `*[_type == "tool"] | order(sortOrder asc, title asc){
    _id,title,category,shortDescription,downloadMode,downloadUrl,officialSite,
    downloadNote,
    "iconUrl":coalesce(icon.asset->url,icon.asset._ref),
    "fileUrl":coalesce(downloadFile.asset->url,downloadFile.asset._ref)
  }`,
  benchmarks: `*[_type == "benchmark"] | order(coalesce(sortOrder, 9999) asc, _createdAt asc){
    title,subtitle,
    beforeImage{...,"dimensions":asset->metadata.dimensions},
    afterImage{...,"dimensions":asset->metadata.dimensions},
    reviewImage{...,"dimensions":asset->metadata.dimensions}
  }`,
  "discord-banner": `*[_type == "discordBanner"][0]{text,mobileText,link}`,
  terms: `*[_type == "terms"][0]{title,lastUpdated,sections[]{heading,content}}`,
  "privacy-policy": `*[_type == "privacyPolicy"][0]{
    title,lastUpdated,sections[]{heading,content}
  }`,
  "reviews-gallery": `*[_type == "review"] | order(_createdAt desc){
    image{...,"dimensions":asset->metadata.dimensions},alt
  }`,
  "referral-box": `*[_type == "referralBox"][0]{
    heading,description,emailPlaceholder,startButtonText,loginButtonText,
    loginPath,registerPath
  }`,
  package: `*[_type == "package" && title in $titles][0]{
    title,price,tag,features,buttonText
  }`,
  "upgrade-link": `*[_type == "upgradeLink" && lower(slug.current) == $slug][0]{
    title,intro,targetPackage->{title,price}
  }`,
});

export const PUBLIC_CONTENT_RESOURCES = Object.freeze(
  Object.keys(PUBLIC_CONTENT_QUERIES),
);
