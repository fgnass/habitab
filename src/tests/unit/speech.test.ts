import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestModel } from '../../app/speech';

const MODELS = ['de-AT', 'de-CH', 'de-DE', 'en-AE', 'en-AU', 'en-CA', 'en-GB', 'en-US', 'pt-BR', 'pt-PT'];

test('a language with its own model keeps it', () => {
  assert.equal(nearestModel('en-GB', MODELS), 'en-GB');
});

test('a language without a model gets its usual region, not the first in the list', () => {
  assert.equal(nearestModel('en-DE', MODELS), 'en-US');
  assert.equal(nearestModel('de-IT', MODELS), 'de-DE');
  assert.equal(nearestModel('pt', MODELS), 'pt-BR');
});

test('without the usual region: any model of the language, else unchanged', () => {
  assert.equal(nearestModel('en-DE', ['en-AU', 'en-GB']), 'en-AU');
  assert.equal(nearestModel('fi-FI', MODELS), 'fi-FI');
});
