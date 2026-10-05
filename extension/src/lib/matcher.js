/*
 * Decides which answer to pick. `solve()` is pure: it receives the text that
 * the content script read from the page and returns which answer choice(s)
 * are correct according to the user's answer keys, or why it can't tell.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'));
  else root.QAMatcher = factory(root.QAText);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  const QUESTION_MIN = 0.82; // similarity needed for an approximate question match
  const QUESTION_MARGIN = 0.04; // ...and how far it must beat a match that would answer differently
  const OPTION_MIN = 0.75; // the same for answer choices
  const OPTION_MARGIN = 0.1;
  const MIN_OPTION_OVERLAP = 0.5; // approximate matches must share this share of answer choices
  const FUZZY_TEXTS = 8; // most prominent page texts tried for approximate matches

  /** Lookup structure over all enabled answer keys. */
  class KeyIndex {
    constructor(sets) {
      this.entries = [];
      this.sets = [];
      this.byStrict = new Map();
      this.byLoose = new Map();
      for (const set of Array.isArray(sets) ? sets : []) {
        if (!set || set.enabled === false || !Array.isArray(set.entries)) continue;
        const entries = [];
        set.entries.forEach((raw, i) => {
          const entry = prepare(raw, set, i);
          if (!entry) return;
          entries.push(entry);
          this.entries.push(entry);
          addTo(this.byStrict, entry.qfp.strict, entry);
          if (entry.qfp.loose) addTo(this.byLoose, entry.qfp.loose, entry);
        });
        if (entries.length) this.sets.push({ id: set.id, name: set.name, entries });
      }
    }

    get size() {
      return this.entries.length;
    }

    /** Entries whose question equals `text` (ignoring case, spacing and punctuation). */
    exact(text) {
      const fp = T.questionFingerprint(text);
      if (!fp.strict) return [];
      return this.byStrict.get(fp.strict) || (fp.loose && this.byLoose.get(fp.loose)) || [];
    }

    /** Entries whose question is very similar to `text`, best first. */
    fuzzy(text) {
      const fp = T.questionFingerprint(text);
      if (fp.loose.length < 6) return [];
      const la = fp.loose.length - 1;
      const out = [];
      for (const entry of this.entries) {
        const q = entry.qfp;
        // Numbers and negations must agree: "7 x 8" is not "7 x 9", "is" is not "is not".
        if (q.nums !== fp.nums || q.neg !== fp.neg) continue;
        const lb = q.loose.length - 1;
        if ((2 * Math.min(la, lb)) / (la + lb) < QUESTION_MIN) continue;
        const score = T.similarity(fp, q);
        if (score >= QUESTION_MIN) out.push({ entry, score });
      }
      return out.sort((a, b) => b.score - a.score);
    }

    /** Entries whose answer choices are exactly the given ones (in any order). */
    sameOptions(options) {
      return this.entries.filter(
        (entry) =>
          entry.optfps.length === options.length &&
          options.every((o) => entry.optfps.some((k) => sameText(k, o))) &&
          entry.optfps.every((k) => options.some((o) => sameText(k, o)))
      );
    }
  }

  function prepare(raw, set, i) {
    if (!raw || typeof raw.q !== 'string' || !Array.isArray(raw.correct) || !raw.correct.length) return null;
    const qfp = T.questionFingerprint(raw.q);
    if (!qfp.strict) return null;
    const options = Array.isArray(raw.options) ? raw.options.map(String) : [];
    const correct = raw.correct.map(String);
    return {
      id: `${set.id}#${i}`,
      setId: set.id,
      setName: set.name || 'Answer key',
      n: Number.isInteger(raw.n) ? raw.n : i + 1,
      q: raw.q,
      qfp,
      options,
      optfps: options.filter(Boolean).map(T.optionFingerprint),
      correct,
      correctfps: correct.map(T.optionFingerprint),
      correctIdx: Array.isArray(raw.correctIdx) ? raw.correctIdx.filter(Number.isInteger) : [],
    };
  }

  function addTo(map, key, value) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }

  function sameText(a, b) {
    return a.strict === b.strict || a.bare === b.bare || (!!a.loose && a.loose === b.loose);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Index of the choice in `options` (fingerprints, or null to skip) that shows
   * `target`, or -1 when it is missing or can't be told apart from another choice.
   * `exactOnly` disables the "contains" and approximate tiers.
   */
  function findOption(target, options, exactOnly) {
    const tiers = [
      (o) => o.strict === target.strict,
      (o) => o.bare === target.bare,
      (o) => !!target.loose && o.loose === target.loose,
    ];
    for (let t = 0; t < tiers.length; t++) {
      const hits = [];
      options.forEach((o, i) => {
        if (o && o.strict && tiers[t](o)) hits.push(i);
      });
      // Several identical texts are interchangeable; several *similar* ones ("-5"/"5") are not.
      if (hits.length === 1 || (hits.length > 1 && t < 2)) return hits[0];
      if (hits.length > 1) return -1;
    }
    if (exactOnly || !target.loose) return -1;

    // The answer surrounded by extra text, e.g. "Triangle Paris".
    const word = new RegExp(`(^| )${escapeRegExp(target.loose)}( |$)`);
    const within = [];
    options.forEach((o, i) => {
      if (o && o.loose && word.test(o.loose)) within.push(i);
    });
    if (within.length === 1) return within[0];
    if (within.length > 1) return -1;

    // Slightly different spelling: only when one choice is clearly the closest.
    let best = -1;
    let bestScore = 0;
    let second = 0;
    options.forEach((o, i) => {
      if (!o || !o.loose || o.nums !== target.nums || o.neg !== target.neg) return;
      const s = T.similarity(o, target);
      if (s > bestScore) {
        second = bestScore;
        bestScore = s;
        best = i;
      } else if (s > second) {
        second = s;
      }
    });
    return bestScore >= OPTION_MIN && bestScore - second >= OPTION_MARGIN ? best : -1;
  }

  /** Indices of the on-screen choices that are correct for `entry`. */
  function matchTargets(entry, options) {
    // Choices the key lists as wrong are never picked, even approximately.
    const wrong = entry.optfps.filter((k) => !entry.correctfps.some((c) => sameText(c, k)));
    const usable = options.map((o) => (o && o.strict && !wrong.some((w) => sameText(w, o)) ? o : null));
    const out = [];
    for (const c of entry.correctfps) {
      const i = findOption(c, usable, false);
      if (i >= 0 && !out.includes(i)) out.push(i);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * @param {KeyIndex} index
   * @param {object} view what the content script read from the page:
   *   questions      string[]  text of the site's question element(s)
   *   options        string[]  text of the site's answer buttons ('' when they show no text)
   *   optionKeys     number[]  site-specific position of each button (Kahoot's answer-N)
   *   blocks         {text, weight, clickable, inOption}[]  every visible text on the page
   *   questionNumber number|null  e.g. Kahoot's "3 of 10" counter
   *   preferredSetId string|null  answer key that matched the previous question
   * @param {{fuzzy?: boolean}} settings
   * @returns {object} {ok: true, how, score, entry, questionText, optionTargets, blockTargets}
   *   or {ok: false, reason, entry?}
   */
  function solve(index, view, settings) {
    if (!index || !index.size) return { ok: false, reason: 'no-keys' };
    const allowFuzzy = !settings || settings.fuzzy !== false;
    const optionTexts = (view.options || []).map((t) => t || '');
    const options = optionTexts.map((t) => (t ? T.optionFingerprint(t) : null));
    const textOptions = options.filter((o) => o && o.strict).length;
    const useOptions = textOptions >= 2;
    const blocks = view.blocks || [];
    const questions = (view.questions || []).filter(Boolean);
    const questionBlocks = blocks.filter((b) => !b.inOption);

    function targetsFor(entry, questionText) {
      if (useOptions) {
        const optionTargets = matchTargets(entry, options);
        return optionTargets.length ? { optionTargets, blockTargets: [] } : null;
      }
      // No answer buttons known for this site: look for a clickable element showing the answer.
      const q = questionText ? T.questionFingerprint(questionText).strict : '';
      const pool = blocks.map((b) =>
        b.clickable && T.questionFingerprint(b.text).strict !== q ? T.optionFingerprint(b.text) : null
      );
      const blockTargets = [];
      for (const c of entry.correctfps) {
        const i = findOption(c, pool, true);
        if (i >= 0 && !blockTargets.includes(i)) blockTargets.push(i);
      }
      return blockTargets.length ? { optionTargets: [], blockTargets } : null;
    }

    function overlap(entry) {
      if (!useOptions || !entry.optfps.length) return 0;
      let hits = 0;
      for (const o of options) if (o && entry.optfps.some((k) => sameText(k, o))) hits++;
      return hits / Math.max(textOptions, entry.optfps.length);
    }

    const signature = (c) => c.optionTargets.join(',') + '/' + c.blockTargets.join(',');

    function success(how, c) {
      return {
        ok: true,
        how,
        score: c.score,
        entry: c.entry,
        questionText: c.questionText || '',
        optionTargets: c.optionTargets,
        blockTargets: c.blockTargets,
      };
    }

    // Candidates whose answer is on screen; null when none is.
    function decide(candidates, how) {
      const scored = [];
      for (const c of candidates) {
        const targets = targetsFor(c.entry, c.questionText);
        if (targets) scored.push(Object.assign({}, c, targets, { overlap: overlap(c.entry) }));
      }
      if (!scored.length) return null;
      const bestOverlap = Math.max(...scored.map((c) => c.overlap));
      const top = scored.filter((c) => c.overlap === bestOverlap).sort((a, b) => b.score - a.score);
      if (top.some((c) => signature(c) !== signature(top[0]))) {
        return { ok: false, reason: 'ambiguous', entry: top[0].entry };
      }
      return success(how, top[0]);
    }

    let pending = null; // recognised question whose answer isn't on screen (yet)

    // 1. Exact question text: the site's question element first, then any text on the page.
    //    Clickable texts are tried last - they are usually answer choices, not questions.
    const tiers = [
      { texts: questions, authoritative: true },
      { texts: questionBlocks.filter((b) => !b.clickable).map((b) => b.text), authoritative: true },
      { texts: questionBlocks.filter((b) => b.clickable).map((b) => b.text), authoritative: false },
    ];
    for (const tier of tiers) {
      const candidates = [];
      for (const text of tier.texts) {
        for (const entry of index.exact(text)) candidates.push({ entry, score: 1, questionText: text });
      }
      if (!candidates.length) continue;
      const result = decide(candidates, 'exact');
      if (result) return result;
      pending = { ok: false, reason: 'answer-not-found', entry: candidates[0].entry, questionText: candidates[0].questionText };
      // An exact match on the question itself is trusted: rather wait than guess another entry.
      if (tier.authoritative) return pending;
    }

    // 2. Approximate question text (slightly reworded or a typo fixed).
    if (allowFuzzy) {
      const texts = questions.length
        ? questions
        : questionBlocks
            .filter((b) => !b.clickable)
            .sort((a, b) => (b.weight || 0) - (a.weight || 0))
            .slice(0, FUZZY_TEXTS)
            .map((b) => b.text);
      const candidates = [];
      for (const text of texts) {
        for (const m of index.fuzzy(text)) candidates.push({ entry: m.entry, score: m.score, questionText: text });
      }
      candidates.sort((a, b) => b.score - a.score);
      const answerable = [];
      for (const c of candidates) {
        if (useOptions && c.entry.optfps.length && overlap(c.entry) < MIN_OPTION_OVERLAP) continue;
        const targets = targetsFor(c.entry, c.questionText);
        if (targets) answerable.push(Object.assign({}, c, targets));
      }
      if (answerable.length) {
        const best = answerable[0];
        const rival = answerable.find((c) => signature(c) !== signature(best) && best.score - c.score < QUESTION_MARGIN);
        if (rival) return { ok: false, reason: 'ambiguous', entry: best.entry };
        return success('fuzzy', best);
      }
      if (candidates.length && !pending) {
        pending = { ok: false, reason: 'answer-not-found', entry: candidates[0].entry, questionText: candidates[0].questionText };
      }
    }

    // 3. No question text matched, but the set of answer choices identifies it.
    if (useOptions) {
      const shown = options.filter((o) => o && o.strict);
      let candidates = index.sameOptions(shown).map((entry) => ({ entry, score: 1, questionText: '' }));
      if (candidates.length > 1 && view.questionNumber != null) {
        const byNumber = candidates.filter(
          (c) => c.entry.n === view.questionNumber && (!view.preferredSetId || c.entry.setId === view.preferredSetId)
        );
        if (byNumber.length) candidates = byNumber;
      }
      if (candidates.length) {
        const result = decide(candidates, 'options');
        if (result) return result;
      }
    }

    // 4. Answer buttons without any text (Kahoot when questions aren't shown on devices):
    //    use the question number and the answer's position in the key.
    if (options.length >= 2 && !textOptions) {
      if (view.questionNumber == null || !Array.isArray(view.optionKeys)) return { ok: false, reason: 'no-text' };
      let set = view.preferredSetId ? index.sets.find((s) => s.id === view.preferredSetId) : null;
      if (!set && index.sets.length === 1) set = index.sets[0];
      if (!set) return { ok: false, reason: 'no-text' };
      const entry = set.entries.find((e) => e.n === view.questionNumber);
      if (!entry || !entry.correctIdx.length) return { ok: false, reason: 'no-number-match', number: view.questionNumber };
      const optionTargets = [];
      view.optionKeys.forEach((key, i) => {
        if (entry.correctIdx.includes(key)) optionTargets.push(i);
      });
      if (!optionTargets.length) return { ok: false, reason: 'answer-not-found', entry };
      return success('number', { entry, score: 1, questionText: '', optionTargets, blockTargets: [] });
    }

    return pending || { ok: false, reason: 'no-match' };
  }

  return { KeyIndex, solve, findOption, matchTargets };
});
