import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { imageSizePath, makeImageSizes } from '../../src/server/cms/imageSizes.js';

const PUBLIC_PREFIX = '/storage/v1/object/public/site-content-public/';
const RENDER_PREFIX = '/storage/v1/render/image/public/site-content-public/';
const RESIZE_FIT = { cover: 'cover', contain: 'inside', fill: 'fill' };
const DEFAULT_RESIZE_QUALITY = 80;

const photo = (width, height, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${hue + 70},60%,22%)"/></linearGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="5" seed="${hue}"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.55 0"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#sky)"/>
  <rect width="100%" height="100%" filter="url(#grain)"/>
  <circle cx="${width * 0.3}" cy="${height * 0.4}" r="${height * 0.22}" fill="hsl(${hue + 150},80%,70%)" opacity="0.85"/>
  <path d="M0 ${height * 0.8} L${width * 0.35} ${height * 0.45} L${width * 0.6} ${height * 0.7} L${width * 0.8} ${height * 0.5} L${width} ${height * 0.75} V${height} H0 Z" fill="hsl(${hue + 200},45%,18%)"/>
</svg>`;
const screenshot = (width, height, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#313338"/>
  ${Array.from({ length: Math.floor((height - 40) / 46) }, (_, line) => `<circle cx="38" cy="${52 + line * 46}" r="16" fill="hsl(${line * 47},60%,55%)"/>
  <text x="68" y="${48 + line * 46}" fill="#f2f3f5" font-family="sans-serif" font-size="16" font-weight="700">Synthetic client ${line + 1}</text>
  <text x="68" y="${68 + line * 46}" fill="#dbdee1" font-family="sans-serif" font-size="15">${label}: frames went from ${140 + line * 11} to ${310 + line * 23} after the session.</text>`).join('\n  ')}
</svg>`;
const vector = (width, height) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#18202c"/><text x="24" y="48" fill="white" font-size="24">Synthetic vector review</text></svg>`;

const raster = async (svg, extension) => {
  const pipeline = sharp(Buffer.from(svg));
  return extension === 'jpg' ? pipeline.jpeg({ quality: 92 }).toBuffer() : pipeline.png().toBuffer();
};
const reference = image => ({ _type: 'image', asset: { _type: 'reference', _ref: image.id } });

export async function createImageSizesContent() {
  const images = [];
  const add = async (name, width, height, extension, svg, { filled = true } = {}) => {
    const body = extension === 'svg' ? Buffer.from(svg) : await raster(svg, extension);
    const sha1 = createHash('sha1').update(body).digest('hex');
    const made = filled ? await makeImageSizes({ bytes: body, extension, width, height }) : null;
    const image = {
      name, width, height, body, sha1,
      id: `image-${sha1}-${width}x${height}-${extension}`,
      storagePath: `images/${sha1}.${extension}`,
      mimeType: extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' ? 'image/jpeg' : 'image/png',
      ...(made ? { sizes: made.map(size => size.width) } : {}),
      files: new Map((made || []).map(size => [imageSizePath(sha1, size.width), size.bytes])),
    };
    images.push(image);
    return image;
  };
  const avatars = [await add('avatar-square', 256, 256, 'png', photo(256, 256, 20)), await add('avatar-wide', 600, 300, 'jpg', photo(600, 300, 200))];
  const covers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(index => add(`cover-${index}`, 900, 1200, 'jpg', photo(900, 1200, index * 45))));
  const shapedCovers = [
    await add('cover-wide', 1600, 900, 'jpg', photo(1600, 900, 30)),
    await add('cover-strip', 1145, 334, 'jpg', photo(1145, 334, 75)),
    await add('cover-tall', 600, 1200, 'jpg', photo(600, 1200, 165)),
  ];
  const team = {
    founder: await add('team-founder', 800, 1200, 'jpg', photo(800, 1200, 210)),
    alpha: await add('team-alpha', 3209, 2000, 'jpg', photo(3209, 2000, 255)),
    beta: await add('team-beta', 256, 256, 'png', photo(256, 256, 300)),
  };
  const reviews = [
    await add('review-screenshot', 800, 500, 'png', screenshot(800, 500, 'Valorant')),
    await add('review-photo', 1600, 1066, 'jpg', photo(1600, 1066, 300)),
    await add('review-tall', 720, 1280, 'png', screenshot(720, 1280, 'Fortnite')),
    await add('review-photo-small', 1000, 750, 'jpg', photo(1000, 750, 110)),
    await add('review-unfilled', 1000, 700, 'jpg', photo(1000, 700, 250), { filled: false }),
    await add('review-vector', 800, 400, 'svg', vector(800, 400)),
  ];
  const benchmarks = [
    await add('benchmark-before', 1920, 1080, 'png', screenshot(1920, 1080, 'Before')),
    await add('benchmark-after', 1920, 1080, 'png', screenshot(1920, 1080, 'After')),
    await add('benchmark-review', 1100, 420, 'png', screenshot(1100, 420, 'Review')),
  ];

  const respond = async (url, res) => {
    const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); return true; };
    if (url.pathname === '/__image-sizes') {
      return send('application/json', JSON.stringify(images.map(({ name, sha1, width, sizes, storagePath }) => ({ name, sha1, width, sizes: sizes ?? null, storagePath }))));
    }
    if (url.pathname.startsWith(PUBLIC_PREFIX)) {
      const path = url.pathname.slice(PUBLIC_PREFIX.length);
      const original = images.find(image => image.storagePath === path);
      if (original) return send(original.mimeType, original.body);
      const size = images.map(image => image.files.get(path)).find(Boolean);
      return size ? send('image/webp', size) : false;
    }
    if (!url.pathname.startsWith(RENDER_PREFIX)) return false;
    const original = images.find(image => image.storagePath === url.pathname.slice(RENDER_PREFIX.length));
    if (!original) return false;
    const number = name => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
    const resized = sharp(original.body).resize({ width: number('width'), height: number('height'), fit: RESIZE_FIT[url.searchParams.get('resize') || 'cover'], withoutEnlargement: true });
    if (url.searchParams.get('format') === 'origin') return send(original.mimeType, await resized.toBuffer());
    return send('image/webp', await resized.webp({ quality: number('quality') ?? DEFAULT_RESIZE_QUALITY }).toBuffer());
  };

  return {
    images,
    respond,
    avatar: index => reference(avatars[index % avatars.length]),
    team: { founder: reference(team.founder), alpha: reference(team.alpha), beta: reference(team.beta) },
    games: {
      title: 'Synthetic games',
      featuredGames: covers.slice(0, 6).map((cover, index) => ({ _key: `featured-${index}`, title: `Featured game ${index + 1}`, coverImage: reference(cover) })),
      moreGames: [
        ...covers.slice(6).map((cover, index) => ({ _key: `more-${index}`, title: `Extra game ${index + 1}`, coverImage: reference(cover) })),
        ...shapedCovers.map(cover => ({ _key: `more-${cover.name}`, title: `Game with a ${cover.name}`, coverImage: reference(cover) })),
      ],
    },
    reviews: reviews.map(image => ({ id: `review-${image.name}`, alt: `Fixture ${image.name.replaceAll('-', ' ')}`, image: reference(image) })),
    benchmark: {
      title: 'Fixture Benchmark Gamma',
      subtitle: 'Synthetic before and after results for Gamma.',
      sortOrder: 1,
      beforeImage: reference(benchmarks[0]),
      afterImage: reference(benchmarks[1]),
      reviewImage: reference(benchmarks[2]),
    },
  };
}
