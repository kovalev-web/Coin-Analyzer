import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRu, keyLabel, DIMENSIONS } from './edge-insights.js';

test('group keys from the server read in Russian; unknown keys pass through', () => {
  assert.equal(keyRu('not tagged'), 'без пометки');
  assert.equal(keyLabel('Calm, by plan'), 'Спокойно, по плану');
  assert.equal(keyLabel('08–12'), '08–12');
  assert.equal(DIMENSIONS.hour, 'Время дня');
});
