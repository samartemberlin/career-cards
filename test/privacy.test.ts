import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMasker, maskText, classifyDetail, PrivacyError } from '../src/privacy.ts';

describe('privacy masking', () => {
  it('masks name variants with case and spacing differences', () => {
    const m = buildMasker(['Jane Roe', 'Jane']);
    assert.strictEqual(
      maskText('JANE  ROE wrote; jane agreed', m),
      '[USER] wrote; [USER] agreed',
    );
  });

  it('masks email, phone, link by pattern even if not listed', () => {
    const m = buildMasker(['Jane Roe']);
    const text = 'Contact jane.roe@example.com or call +49 30 1234 5678 or visit https://example.com/jobs';
    const result = maskText(text, m);
    assert.ok(!result.includes('@'), 'email should be masked');
    assert.ok(!result.includes('https://'), 'link should be masked');
    assert.ok(result.includes('[EMAIL]'), 'email replaced with [EMAIL]');
    assert.ok(result.includes('[PHONE]'), 'phone replaced with [PHONE]');
    assert.ok(result.includes('[LINK]'), 'link replaced with [LINK]');
  });

  it('address prefix gives [ADDRESS]', () => {
    const m = buildMasker(['address: Musterstr. 1']);
    assert.strictEqual(maskText('Send to Musterstr. 1 Berlin', m), 'Send to [ADDRESS] Berlin');
  });

  it('empty details list throws PrivacyError', () => {
    assert.throws(() => buildMasker([]), (err: unknown) => {
      assert.ok(err instanceof PrivacyError, 'should be PrivacyError');
      assert.ok((err as PrivacyError).message.includes('no personal details'));
      return true;
    });
  });

  it('job text with an unrelated URL is masked as [LINK]', () => {
    const m = buildMasker(['Jane Roe']);
    const text = 'Apply at www.company.de/jobs/123 before the deadline';
    const result = maskText(text, m);
    assert.ok(result.includes('[LINK]'), 'URL replaced with [LINK]');
    assert.ok(!result.includes('www.company.de'), 'original URL removed');
  });

  it('error message never contains the detail value', () => {
    // A detail whose value equals the placeholder makes masking a no-op for that detail,
    // triggering the fail-closed throw. The error must not reveal the detail text.
    const secretDetail = '[USER]';
    const m = buildMasker([secretDetail]);
    assert.throws(() => maskText('[USER] should not leak', m), (err: unknown) => {
      assert.ok(err instanceof PrivacyError, 'should be PrivacyError');
      assert.ok(!(err as PrivacyError).message.includes(secretDetail),
        'error must not contain the detail value');
      return true;
    });
  });

  it('classifyDetail returns correct kinds', () => {
    assert.strictEqual(classifyDetail('Jane Roe'), 'name');
    assert.strictEqual(classifyDetail('jane@example.com'), 'email');
    assert.strictEqual(classifyDetail('address: Musterstr. 1'), 'address');
    assert.strictEqual(classifyDetail('https://linkedin.com/in/x'), 'link');
    assert.strictEqual(classifyDetail('+49 30 12345678'), 'phone');
  });

  it('longer detail masked before shorter substring', () => {
    const m = buildMasker(['Jane', 'Jane Roe']);
    // 'Jane Roe' must be replaced as one unit, not 'Jane' first leaving 'Roe'
    assert.strictEqual(maskText('Jane Roe applied', m), '[USER] applied');
  });
  // Protections from samjobs' anonymize.mjs that the first port lost.
  it('invisible characters and decomposed letters cannot hide a name', () => {
    const m = buildMasker(['Theo Example', 'José']);
    const out = maskText('The\u00ADo Exam\u200Bple and Jose\u0301 wrote', m);
    assert.strictEqual(out, '[USER] and [USER] wrote');
  });

  it('the fail-closed check sees through invisible characters', () => {
    // The detail equals its placeholder, so masking leaves it; the check must still find it behind a zero-width space.
    const m = buildMasker(['[USER]']);
    assert.throws(() => maskText('[US\u200BER]', m), PrivacyError);
  });

  it('bare-domain personal links are masked', () => {
    const m = buildMasker(['Jane Roe']);
    const out = maskText('see linkedin.com/in/jane-roe and github.com/janeroe, janeroe.de', m);
    assert.doesNotMatch(out, /linkedin|github|janeroe|\.de/);
    assert.strictEqual(maskText('Node.js and e.g. Excel, GPA 3.91', m), 'Node.js and e.g. Excel, GPA 3.91');
  });

  it('a bare-domain detail is a link', () => {
    assert.strictEqual(classifyDetail('linkedin.com/in/theo-example'), 'link');
    const m = buildMasker(['Theo Example', 'linkedin.com/in/theo-example']);
    assert.strictEqual(maskText('Profile: linkedin.com/in/theo-example', m), 'Profile: [LINK]');
  });

  it('short names match whole words only; long names also inside joined words', () => {
    const m = buildMasker(['Theo', 'Josephine']);
    assert.strictEqual(maskText('Theo moved to Theory; JosephineExample', m), '[USER] moved to Theory; [USER]Example');
  });

  it('dates, year ranges and number ranges are not phone numbers; slash phones are', () => {
    const m = buildMasker(['Theo Example']);
    const text = 'Job in Berlin, worked 2019-2021 and 2019–2021, deadline 2026-11-30, salary 50000-60000 EUR, 50.000 - 60.000';
    assert.strictEqual(maskText(text, m), text);
    assert.strictEqual(maskText('call 0170/5550123 or 030 1234 5678 or 030-1234567.', m), 'call [PHONE] or [PHONE] or [PHONE].');
  });
});
