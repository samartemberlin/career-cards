import test from 'node:test';
import assert from 'node:assert/strict';
import { jobKey, fingerprint, canonicalUrl } from '../../src/pipeline/keys.ts';

test('jobKey uses ATS ids when the URL carries one', () => {
  assert.equal(jobKey('https://boards.greenhouse.io/acme/jobs/12345?gh_src=x'), 'greenhouse:acme:12345');
  assert.equal(jobKey('https://job-boards.eu.greenhouse.io/acme/jobs/9'), 'greenhouse:acme:9');
  assert.equal(jobKey('https://jobs.lever.co/acme/123e4567-e89b-12d3-a456-426614174000'), 'lever:acme:123e4567-e89b-12d3-a456-426614174000');
  assert.equal(jobKey('https://acme.jobs.personio.de/job/42?language=en'), 'personio:acme:42');
  assert.equal(jobKey('https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1234567890-S'), 'ba:10000-1234567890-S');
  assert.equal(jobKey('https://interamt.de/koop/app/stelle?id=998877'), 'interamt:998877');
});

test('jobKey falls back to a stable hash of the canonical URL', () => {
  const a = jobKey('https://Example.org/jobs/1/?utm_source=x#top');
  const b = jobKey('https://example.org/jobs/1');
  assert.equal(a, b);
  assert.match(a, /^url:[0-9a-f]{12}$/);
  assert.notEqual(a, jobKey('https://example.org/jobs/2'));
});

test('canonicalUrl sorts params and drops tracking', () => {
  assert.equal(canonicalUrl('https://x.org/a?b=2&a=1&utm_medium=m'), 'https://x.org/a?a=1&b=2');
});

test('fingerprint ignores case, legal suffixes, gender tags and accents', () => {
  const a = fingerprint('Müller GmbH', 'Projektkoordinator (m/w/d)');
  assert.equal(a, fingerprint('MULLER', 'projektkoordinator'));
  assert.notEqual(a, fingerprint('Müller GmbH', 'Projektleiter'));
});
