export const normalizedCards = [
  '%34' + '%31'.repeat(15),
  '4111%201111%201111%201111',
  '4111%2D1111%2D1111%2D1111',
  encodeURIComponent('4111–1111–1111–1111'),
  encodeURIComponent('４１１１１１１１１１１１１１１１'),
  ...['‐', '‑', '‒', '–', '—', '−', '－', '·', '・', '．'].map(separator => ['4111', '1111', '1111', '1111'].join(separator)),
  '4111  1111  1111  1111',
  '4111 - 1111 - 1111 - 1111',
  '4111 . 1111 . 1111 . 1111',
  '%FF' + '%34' + '%31'.repeat(15),
];
export const normalizedEmails = [
  'a@b%2F.c', 'a@b%5C.c', 'a@b%2f.c', 'a@b%5c.c',
  'a%40b%2F.c', 'buyer@example%2Fpath.com', 'a@b/.c', 'a@b\\.c',
  'bad%FFbuyer%40example.com', 'node_modules/.vite/deps/@sentry_browser.js', 'a/@b.com', 'a@.b.c', 'a%40.b.c',
];
export const separatorRuns = ['1' + ' '.repeat(16000) + '2', '1' + ' -'.repeat(8000) + '2', '1' + '.'.repeat(16000) + '2'];
export const releaseSha = 'a1234567890123' + 'b'.repeat(26);
export const samplingId = 'a1234567890123' + 'b'.repeat(18);
