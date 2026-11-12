import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJobPosting, htmlToText, normalizeEmploymentType } from '../../src/pipeline/html.ts';
import { join } from 'node:path';
import { fetchJd } from '../../src/pipeline/jd.ts';
import type { FetchLike } from '../../src/pipeline/jd.ts';

const longText = 'Sie koordinieren Projekte und organisieren Workshops. '.repeat(10);
const page = (jp: object): string =>
  `<html><head><script type="application/ld+json">${JSON.stringify(jp)}</script></head><body><nav>Menu</nav></body></html>`;
const okFetch = (html: string): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => html });

test('htmlToText handles tags, lists, entities and escaped markup', () => {
  assert.equal(
    htmlToText('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>'),
    'Hello & welcome\n\n- One\n- Two',
  );
  assert.equal(htmlToText('&lt;p&gt;Escaped &uuml;ber&lt;/p&gt;'), 'Escaped über');
  assert.equal(htmlToText('<script>x()</script>Text'), 'Text');
});

test('extractJobPosting finds the posting in arrays and @graph', () => {
  assert.equal(extractJobPosting(page({ '@type': 'JobPosting', title: 'A' }))?.title, 'A');
  assert.equal(
    extractJobPosting(page({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['JobPosting'], title: 'B' }] }))?.title,
    'B',
  );
  assert.equal(extractJobPosting(page([{ '@type': 'Org' }])), null);
  assert.equal(extractJobPosting('<script type="application/ld+json">{broken</script>'), null);
});

test('normalizeEmploymentType maps any intern flavour to "intern"', () => {
  assert.equal(normalizeEmploymentType('FULL_TIME'), 'full_time');
  assert.equal(normalizeEmploymentType(['PART_TIME', 'INTERN']), 'intern');
  assert.equal(normalizeEmploymentType(undefined), null);
});

test('fetchJd: JSON-LD gives text, deadline and employment type', async () => {
  const html = page({
    '@type': 'JobPosting',
    description: `<p>${longText}</p>`,
    validThrough: '2026-11-21T07:09:22+01:00',
    datePosted: '2026-10-02',
    employmentType: 'FULL_TIME',
  });
  const r = await fetchJd({ key: 'ba:1', url: 'https://x.org/1' }, { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.equal(r.meta.source, 'jsonld');
  assert.equal(r.meta.deadline, '2026-11-21');
  assert.equal(r.meta.posted, '2026-10-02');
  assert.equal(r.meta.employment_type, 'full_time');
  assert.ok(r.jd.startsWith('Sie koordinieren'));
});

test('fetchJd: known ATS goes through fetch-jd first; a miss falls back to the page', async () => {
  const hit = await fetchJd(
    { key: 'greenhouse:acme:1', url: 'https://x.org/1' },
    {
      careerOpsDir: '/x',
      atsFetch: async () => longText,
      fetchImpl: async () => { throw new Error('should not be called'); },
    },
  );
  assert.ok(hit !== null);
  assert.equal(hit.meta.source, 'ats-api');

  const miss = await fetchJd(
    { key: 'lever:acme:1', url: 'https://x.org/1' },
    {
      careerOpsDir: '/x',
      atsFetch: async () => null,
      fetchImpl: okFetch(page({ '@type': 'JobPosting', description: longText })),
    },
  );
  assert.ok(miss !== null);
  assert.equal(miss.meta.source, 'jsonld');
});

test('fetchJd: returns null (never invents text) for errors and thin pages', async () => {
  assert.equal(
    await fetchJd(
      { key: 'url:a', url: 'u' },
      { fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) },
    ),
    null,
  );
  assert.equal(
    await fetchJd({ key: 'url:a', url: 'u' }, { fetchImpl: async () => { throw new Error('net'); } }),
    null,
  );
  assert.equal(
    await fetchJd(
      { key: 'url:a', url: 'u' },
      { fetchImpl: okFetch('<html><body>Enable JavaScript</body></html>') },
    ),
    null,
  );
});

test('fetchJd: LinkedIn path uses injected linkedinFetch', async () => {
  // LinkedIn fetch hit
  const hit = await fetchJd(
    { key: 'linkedin:1234567', url: 'https://www.linkedin.com/jobs/view/1234567' },
    { linkedinFetch: async () => longText },
  );
  assert.ok(hit !== null);
  assert.equal(hit.meta.source, 'linkedin');
  assert.ok(hit.jd.startsWith('Sie koordinieren'));

  // LinkedIn fetch miss
  const miss = await fetchJd(
    { key: 'linkedin:9999999', url: 'https://www.linkedin.com/jobs/view/9999999' },
    { linkedinFetch: async () => null },
  );
  assert.equal(miss, null);
});

test('fetch-jd gets no secret', async () => {
  const env = {
    PATH: process.env.PATH, HOME: '/home/nobody', LANG: 'C.UTF-8',
    TRELLO_TOKEN: 'trello-token-123456', GEMINI_API_KEY: 'gemini-key-123456', SHELL: '/bin/sh',
  };
  const r = await fetchJd(
    { key: 'greenhouse:acme:1', url: 'https://x.org/1' },
    {
      careerOpsDir: join(import.meta.dirname, '..', 'fixtures', 'career-ops-fake'), env,
      fetchImpl: async () => { throw new Error('should not be called'); },
    },
  );
  assert.equal(r?.meta.source, 'ats-api');
  const names = r!.jd.split(' ').filter((w) => /^[A-Z_]+$/.test(w));
  assert.ok(names.includes('PATH'));
  for (const n of names) assert.ok(['PATH', 'HOME', 'LANG'].includes(n), `unexpected env ${n}`);
});

test('fetchJd: LinkedIn gets the run deadline', async () => {
  let got: number | undefined;
  await fetchJd(
    { key: 'linkedin:1234567', url: 'https://www.linkedin.com/jobs/view/1234567' },
    { linkedinFetch: async (_id, o) => { got = o.deadline; return longText; }, deadline: 12345 },
  );
  assert.equal(got, 12345);
});

test('fetchJd pageOnly: ATS and LinkedIn keys read the page itself, never fetch-jd or the guest API', async () => {
  const html = page({ '@type': 'JobPosting', title: 'Event Planner', description: `<p>${longText}</p>` });
  const never = async (): Promise<string | null> => { throw new Error('should not be called'); };
  for (const job of [
    { key: 'greenhouse:acme:1', url: 'https://boards.greenhouse.io/acme/jobs/1' },
    { key: 'linkedin:1234567', url: 'https://www.linkedin.com/jobs/view/1234567' },
  ]) {
    const r = await fetchJd(job, { pageOnly: true, fetchImpl: okFetch(html), atsFetch: never, linkedinFetch: never });
    assert.equal(r?.meta.title, 'Event Planner', job.key);
  }
});

test('fetchJd: JSON-LD gives title, company and city', async () => {
  const html = page({
    '@type': 'JobPosting', title: 'Event &amp; Venue Planner', description: `<p>${longText}</p>`,
    hiringOrganization: { '@type': 'Organization', name: 'Sample Events' },
    jobLocation: [{ '@type': 'Place', address: { addressLocality: 'Berlin' } }],
  });
  const r = await fetchJd({ key: 'ba:1', url: 'https://x.org/1' }, { fetchImpl: okFetch(html) });
  assert.equal(r?.meta.title, 'Event & Venue Planner');
  assert.equal(r?.meta.company, 'Sample Events');
  assert.equal(r?.meta.location, 'Berlin');
});
