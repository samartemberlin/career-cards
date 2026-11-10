import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPageSources, findJobObjects, jobFromJsonLd, listingLinks, parseEmbeddedJobs } from '../../../src/pipeline/sources/pages.ts';
import { jobKey } from '../../../src/pipeline/keys.ts';

const next = (data: unknown): string =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;

const gh = (id: number, title: string, loc: string, lang = 'de') => ({
  absolute_url: `https://careers.vinted.com/${lang}/jobs/${id}?gh_jid=${id}`,
  title,
  location: { name: loc },
  first_published: '2026-10-08T04:00:00-04:00',
});

test('findJobObjects walks nested data and ignores non-jobs', () => {
  const tree = { a: { dataMap: { x: { jobs: [gh(1, 'Project Coordinator', 'Berlin'), { title: 'No link here' }, { name: 'Dept', url: 'not-a-url' }] } } } };
  const jobs = findJobObjects(tree);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.location, 'Berlin');
  assert.equal(jobs[0]!.posted, '2026-10-08');
});

test('parseEmbeddedJobs: Greenhouse-shaped jobs in __NEXT_DATA__, one row per job even across language urls', () => {
  const html = next({ props: { pageProps: { jobs: { dataMap: { de: { jobs: [gh(11, 'Office Assistant', 'Berlin', 'de')] }, en: { jobs: [gh(11, 'Office Assistant', 'Berlin', 'en'), gh(12, 'Event Manager', 'Hamburg')] } } } } } });
  const rows = parseEmbeddedJobs(html, { name: 'Vinted' });
  assert.equal(rows.length, 3);                          // three distinct urls
  assert.equal(rows[0]!.company, 'Vinted');
  assert.equal(rows[0]!.source, 'page:Vinted');
  assert.equal(jobKey(rows[0]!.url), jobKey(rows[1]!.url)); // ...but one job key per Greenhouse id
  assert.deepEqual(parseEmbeddedJobs('<html>no data</html>', { name: 'x' }), []);
});

test('gh_jid keys: same job in every language collapses', () => {
  assert.equal(jobKey('https://careers.vinted.com/de/jobs/4935908101?gh_jid=4935908101'), 'gh:vinted.com:4935908101');
  assert.equal(jobKey('https://careers.vinted.com/fr/jobs/4935908101?gh_jid=4935908101'), 'gh:vinted.com:4935908101');
});

test('listingLinks resolves relative links and filters by pattern', () => {
  const html = '<a href="/en/job/abc">A</a><a href="/about">x</a><a href="https://other.org/job/zzz">B</a><a href="/en/job/abc#top">dup</a>';
  assert.deepEqual(listingLinks(html, 'https://wwf.onlyfy.jobs/', '/job/'), ['https://wwf.onlyfy.jobs/en/job/abc', 'https://other.org/job/zzz']);
});

test('jobFromJsonLd maps place, remote and organisation', () => {
  const j = jobFromJsonLd(
    { title: 'Referent &amp; Co', datePosted: '2026-10-09T10:00', hiringOrganization: { name: 'WWF Deutschland' }, jobLocation: { address: { addressLocality: 'Berlin', addressRegion: 'BE' } } },
    { name: 'WWF', url: 'https://x/1' },
  );
  assert.deepEqual(j, { url: 'https://x/1', title: 'Referent & Co', company: 'WWF Deutschland', location: 'Berlin, BE', posted: '2026-10-09', source: 'page:WWF' });
  assert.equal(jobFromJsonLd({ title: 'T', jobLocationType: 'TELECOMMUTE' }, { name: 'N', url: 'u' }).location, 'Remote');
});

test('fetchPageSources: paging stops when nothing new, keep_location trims, failures are isolated and reported', async () => {
  const pages: Record<string, string> = {
    1: next({ jobs: [gh(1, 'Office Assistant', 'Berlin'), gh(2, 'Driver', 'Vilnius')] }),
    2: next({ jobs: [gh(1, 'Office Assistant', 'Berlin')] }),
  };
  const fetchImpl = async (u: string) => {
    if (u.includes('broken')) return { ok: false, status: 503, url: u, text: async () => '' };
    const m = /page=(\d)/.exec(u);
    return { ok: true, status: 200, url: u, text: async () => pages[m?.[1] ?? ''] ?? next({}) };
  };
  const rows = await fetchPageSources(
    [
      { name: 'V', type: 'embedded-json', url: 'http://v/?page={page}', max_pages: 4, keep_location: 'berlin' },
      { name: 'B', type: 'embedded-json', url: 'http://broken/?page={page}' },
    ],
    { fetchImpl, sleep: async () => {}, log() {} },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.location, 'Berlin');
  assert.equal(rows.errors.length, 1);
  assert.equal(rows.errors[0]!.company, 'B');
});

test('fetchPageSources: listing-jsonld visits detail pages and skips ones without a posting', async () => {
  const ld = (t: string): string =>
    `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: t, datePosted: '2026-10-01', hiringOrganization: { name: 'WWF' }, jobLocation: { address: { addressLocality: 'Berlin' } } })}</script>`;
  const site: Record<string, string> = {
    'http://w/': '<a href="/job/1">1</a><a href="/job/2">2</a>',
    'http://w/job/1': ld('Referent'),
    'http://w/job/2': '<html>closed</html>',
  };
  const rows = await fetchPageSources(
    [{ name: 'WWF', type: 'listing-jsonld', url: 'http://w/', link: '/job/' }],
    { fetchImpl: async (u) => ({ ok: true, status: 200, url: u, text: async () => site[u] ?? '' }), sleep: async () => {}, log() {} },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'Referent');
});
