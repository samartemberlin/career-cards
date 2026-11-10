import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRssSources, parseRssJobs } from '../../../src/pipeline/sources/rss.ts';

const feed = `<rss><channel>
<item><title><![CDATA[Project Coordinator &amp; Events]]></title><link>https://x.org/job/1/</link><pubDate>Sun, 11 Oct 2026 08:39:51 +0000</pubDate>
<job_listing:location><![CDATA[Berlin, Germany]]></job_listing:location><job_listing:company><![CDATA[Acme &amp; Co]]></job_listing:company></item>
<item><title>No company or location</title><link>https://x.org/job/2/</link><pubDate>garbage</pubDate></item>
<item><title>No link</title><link>not-a-url</link></item>
</channel></rss>`;

test('parseRssJobs maps WP Job Manager items, decodes entities, falls back to source defaults', () => {
  const jobs = parseRssJobs(feed, { name: 'Euro Remote Jobs', location: 'Europe (Remote)' });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], { url: 'https://x.org/job/1/', title: 'Project Coordinator & Events', company: 'Acme & Co', location: 'Berlin, Germany', posted: '2026-10-11', source: 'rss:Euro Remote Jobs' });
  assert.equal(jobs[1]!.company, 'Euro Remote Jobs');
  assert.equal(jobs[1]!.location, 'Europe (Remote)');
  assert.equal(jobs[1]!.posted, '');
});

test('fetchRssSources isolates failures and reports empty feeds instead of silently returning nothing', async () => {
  const logs: string[] = [];
  const fetchImpl = async (u: string) =>
    u.includes('good')
      ? { ok: true, status: 200, text: async () => feed }
      : u.includes('empty')
        ? { ok: true, status: 200, text: async () => '<rss></rss>' }
        : { ok: false, status: 503, text: async () => '' };
  const rows = await fetchRssSources(
    [{ name: 'g', url: 'http://good' }, { name: 'e', url: 'http://empty' }, { name: 'b', url: 'http://bad' }],
    { fetchImpl, log: (m) => logs.push(m) },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.errors.length, 2);
  assert.equal(logs.length, 2);
});
