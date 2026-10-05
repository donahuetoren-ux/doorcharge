/*
 * Text helpers shared by the content script, the manager page and the tests.
 *
 * On-screen text is compared with the answer key at two levels:
 *   strict - case, whitespace, quotes and dashes are unified but punctuation
 *            and symbols are kept, so "-5" and "5" stay different answers;
 *   loose  - only letters and digits are kept (accents removed).
 * A fingerprint bundles both forms plus what the fuzzy matcher needs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QAText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INVISIBLE = /[­​-‍⁠﻿]/g;
  const SINGLE_QUOTES = /[‘’‚‛′`´]/g;
  const DOUBLE_QUOTES = /[“”„‟″]/g;
  const DASHES = /[‐-―−﹘﹣－]/g;
  const TIMES = /[×✕⨯]/g;

  // "Question 3:", "Q3.", "3)" in front of a question (applied to strict text).
  const QUESTION_LABEL = /^(?:(?:question|q)\s*#?\s*\d+(?:\s*(?:of|\/)\s*\d+)?\s*[:.)-]?|\d{1,3}\s*[.):])\s+/;
  // "A)", "b.", "(C)", "[2]", "4:" in front of an answer choice (applied to strict text).
  const OPTION_LABEL = /^(?:\(?[a-h1-8]\s*[.):]|\[[a-h1-8]\])\s+/;

  // Words whose presence flips a question's meaning; fuzzy matches must agree on them.
  const NEGATIONS = new Set([
    'not', 'no', 'never', 'none', 'neither', 'nor', 'except', 'least',
    'false', 'incorrect', 'untrue', 'cannot', 't',
  ]);

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', times: '×', divide: '÷', minus: '−', deg: '°',
    le: '≤', ge: '≥', ne: '≠', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  };

  /** Collapses whitespace and trims; keeps everything else as typed. */
  function clean(input) {
    return input == null ? '' : String(input).replace(/\s+/g, ' ').trim();
  }

  function strict(input) {
    if (input == null) return '';
    return String(input)
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(DASHES, '-')
      .replace(TIMES, 'x')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function loose(input) {
    return strict(input)
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function makeFingerprint(full, bare) {
    const l = loose(bare);
    return {
      strict: full,
      bare,
      loose: l,
      nums: (l.match(/\d+/g) || []).join(' '),
      neg: l.split(' ').filter((w) => NEGATIONS.has(w)).join(' '),
      grams: null,
      gramCount: 0,
    };
  }

  // Fingerprints are requested for the same page text on every scan, so cache them.
  const cache = new Map();
  function memo(kind, text, build) {
    const key = kind + String(text);
    let fp = cache.get(key);
    if (!fp) {
      if (cache.size > 5000) cache.clear();
      fp = build();
      cache.set(key, fp);
    }
    return fp;
  }

  /** Fingerprint of a question; numbering such as "Question 3:" is ignored. */
  function questionFingerprint(text) {
    return memo('q:', text, () => {
      const bare = strict(text).replace(QUESTION_LABEL, '');
      return makeFingerprint(bare, bare);
    });
  }

  /** Fingerprint of an answer choice; `bare` drops labels such as "A)". */
  function optionFingerprint(text) {
    return memo('o:', text, () => {
      const full = strict(text);
      return makeFingerprint(full, full.replace(OPTION_LABEL, ''));
    });
  }

  function grams(fp) {
    if (!fp.grams) {
      const s = fp.loose;
      const map = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        map.set(g, (map.get(g) || 0) + 1);
      }
      fp.grams = map;
      fp.gramCount = Math.max(0, s.length - 1);
    }
    return fp.grams;
  }

  /** Dice coefficient over character bigrams of the loose forms (0..1). */
  function similarity(a, b) {
    if (!a.loose || !b.loose) return 0;
    if (a.loose === b.loose) return 1;
    const ga = grams(a);
    const gb = grams(b);
    if (!a.gramCount || !b.gramCount) return 0;
    const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
    let shared = 0;
    for (const [g, n] of small) {
      const m = big.get(g);
      if (m) shared += Math.min(n, m);
    }
    return (2 * shared) / (a.gramCount + b.gramCount);
  }

  /** Strips tags and decodes entities, e.g. for question text exported as HTML. */
  function htmlToText(input) {
    if (input == null) return '';
    return String(input)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') {
          const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
          try {
            return String.fromCodePoint(code);
          } catch (err) {
            return match;
          }
        }
        const value = ENTITIES[name.toLowerCase()];
        return value == null ? match : value;
      });
  }

  return { clean, strict, loose, questionFingerprint, optionFingerprint, similarity, htmlToText };
});
