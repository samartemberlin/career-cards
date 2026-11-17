// Case-folding and phrase lookup for profile card text.

function foldChar(cp: string): string {
  if (cp === 'ß' || cp === 'ẞ') return 'ss';
  return cp.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
}

/** Lowercase + remove diacritics + ß→ss. */
export function fold(s: string): string {
  let out = '';
  for (const cp of s) out += foldChar(cp);
  return out;
}

/**
 * Build a folded version of `original` and an index map so the original slice
 * can be recovered even when folded length differs (e.g. ß→ss).
 */
function foldedText(original: string): { folded: string; fStart: number[]; fEnd: number[] } {
  // fStart[k] = byte start in original of the char that produced folded[k]
  // fEnd[k]   = byte end (exclusive) in original of that char
  const fStart: number[] = [];
  const fEnd: number[] = [];
  let folded = '';
  let off = 0;
  for (const cp of original) {
    const end = off + cp.length;
    const f = foldChar(cp);
    for (let i = 0; i < f.length; i++) {
      fStart.push(off);
      fEnd.push(end);
    }
    folded += f;
    off = end;
  }
  return { folded, fStart, fEnd };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Find `phrase` in `text`.  Returns the matching slice of the ORIGINAL text,
 * or null when the phrase is absent or blank.
 * - `word`: the match must not be immediately preceded or followed by a letter/digit.
 * - `substring`: any occurrence qualifies.
 * No RegExp is built from the phrase.
 */
export function findPhrase(text: string, phrase: string, mode: 'word' | 'substring'): string | null {
  const foldedPhrase = fold(phrase);
  if (!foldedPhrase) return null;

  const { folded, fStart, fEnd } = foldedText(text);
  const pLen = foldedPhrase.length;

  let from = 0;
  while (true) {
    const idx = folded.indexOf(foldedPhrase, from);
    if (idx === -1) return null;

    const matchEnd = idx + pLen;

    if (mode === 'word') {
      const leftOk = idx === 0 || !WORD_CHAR.test(folded[idx - 1]!);
      const rightOk = matchEnd === folded.length || !WORD_CHAR.test(folded[matchEnd]!);
      if (!leftOk || !rightOk) {
        from = idx + 1;
        continue;
      }
    }

    return text.slice(fStart[idx]!, fEnd[matchEnd - 1]!);
  }
}
