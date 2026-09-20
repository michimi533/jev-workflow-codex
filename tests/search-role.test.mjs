import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAX, selectCandidates } from '../scripts/loop.mjs';

test('Browser search text field survives candidate selection', () => {
  const ax = '20 search text field (settable) Search Wikipedia, ID: searchInput\n102 button Search';
  const elements = parseAX(ax);
  const candidates = selectCandidates(elements, 'Search Wikipedia');
  assert.equal(elements.find(e => e.index === 20)?.role, 'search text field');
  assert.ok(candidates.some(e => e.index === 20 && e.label.includes('Search Wikipedia')));
});
