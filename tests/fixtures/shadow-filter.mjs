const ORDER_OPERATORS = { lt: order => order < 0, lte: order => order <= 0, gt: order => order > 0, gte: order => order >= 0 };
const ORDERED_TYPES = ['string', 'number', 'boolean'];

const readField = (row, path) => path.split('.').reduce((item, key) => item !== null && typeof item === 'object' && !Array.isArray(item) ? item[key] : undefined, row);
const order = (actual, expected) => typeof actual === 'string' ? Buffer.compare(Buffer.from(actual), Buffer.from(expected)) : Number(actual) - Number(expected);

export const matchesShadowFilter = (row, { path, op, value }) => {
  const actual = readField(row, path) ?? null, expected = value ?? null;
  if (op === 'eq') return actual === expected;
  if (op === 'ieq') return typeof actual === 'string' ? actual.toLowerCase() === expected : expected === null;
  if (op === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (!Object.hasOwn(ORDER_OPERATORS, op)) throw new Error('Unsupported fixture filter.');
  return ORDERED_TYPES.includes(typeof actual) && typeof actual === typeof expected && ORDER_OPERATORS[op](order(actual, expected));
};
