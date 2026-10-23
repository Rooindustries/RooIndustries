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
  '4111+1111+1111+1111',
  '4111%2B1111%2B1111%2B1111',
  '4111%2b1111%2b1111%2b1111',
];
export const normalizedEmails = [
  'a@b%2F.c', 'a@b%5C.c', 'a@b%2f.c', 'a@b%5c.c',
  'a%40b%2F.c', 'buyer@example%2Fpath.com', 'a@b/.c', 'a@b\\.c',
  'bad%FFbuyer%40example.com', 'node_modules/.vite/deps/@sentry_browser.js', 'a/@b.com', 'a@.b.c', 'a%40.b.c',
];
export const separatorRuns = ['1' + ' '.repeat(16000) + '2', '1' + ' -'.repeat(8000) + '2', '1' + '.'.repeat(16000) + '2'];
export const releaseSha = 'a1234567890123' + 'b'.repeat(26);
export const samplingId = 'a1234567890123' + 'b'.repeat(18);
export const surfaceCases = [
  ...[
    'https%3A%2F%2Fexample.test%2Fcallback%3Ftoken%3Dsupersecret',
    'callback%3Ftoken%3Dsupersecret',
    'callback%3ftoken%3dsupersecret',
    '/auth/next/https%3A%2F%2Fx.test%2Fcb%3Ftoken%3Dabc',
    '%FFcallback%3Ftoken%3Dsupersecret',
  ].map(value => [value, '[query]', '[query]', '[Filtered]']),
  ['4111+1111+1111+1111', '[card]', 'http://localhost/api/x/[card]', 'keep'],
  ['4111%2B1111%2B1111%2B1111', '[card]', '[card]', 'keep'],
  [new URLSearchParams({ pan: '4111 1111 1111 1111' }).toString(), 'pan=[card]', 'http://localhost/api/x/pan=[card]', 'keep'],
  ...['%27', '%22', '%23', '%20', '%3C', '%3E', '%09', '%0A'].map(stop => [`https://host/path%3F${stop}secret`, '[query]', '[query]', '[Filtered]']),
];
export const plusRun = '1+'.repeat(8000) + '1';
export const querySegments = ['https://example.test/cb?next=https%3A%2F%2Fx.test%2Fcb%3Ftoken%3Dinner"tail%3Ftoken%3Douter', 'lookup?x"callback%3Ftoken%3Douter'];
export const diagnosticControls = ['https://example.test/cb?next=https%3A%2F%2Fx.test%2Fcb%3Ftoken%3Dsupersecret', '2026-10-21T12:34:56+05:30', 'C++17', '1e+21', '+1-202-555-0100'];
