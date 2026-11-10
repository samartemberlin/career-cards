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
});
