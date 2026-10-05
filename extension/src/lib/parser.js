/*
 * Turns a pasted or uploaded answer key into entries the matcher understands:
 *   { q, options, correct, correctIdx, n }
 *
 * Accepted input:
 *   - spreadsheet cells / CSV / TSV with a header row; the Blooket, Kahoot,
 *     Gimkit and Quizizz import templates all work as-is
 *   - one "Question | Answer" per line (or two tab-separated columns)
 *   - "Q: ..." / "A: ..." lines
 *   - JSON: [{question, answer}], {questions: [{question, answers, correctAnswers}]},
 *     choices with {answer, correct: true}, or a plain {"question": "answer"} map
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'));
  else root.QAParser = factory(root.QAText);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  /**
   * @returns {{entries: object[], warnings: string[], format: string}}
   * @throws {Error} with a message meant for the user when nothing usable is found
   */
  function parseAnswerKey(input) {
    const text = String(input == null ? '' : input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new Error('Paste an answer key or choose a file first.');
    const warnings = [];
    let parsed;
    const first = text.trim()[0];
    if (first === '{' || first === '[') {
      parsed = fromJson(text.trim());
    } else if (looksLikeQaLines(text)) {
      parsed = { format: 'Q:/A: lines', items: fromQaLines(text) };
    } else {
      const delimiter = detectDelimiter(text);
      if (!delimiter) {
        throw new Error(
          'Couldn’t recognise the format. Use one “Question | Answer” per line, spreadsheet cells or CSV with a header row, Q:/A: lines, or JSON.'
        );
      }
      parsed = fromTable(parseDelimited(text, delimiter), delimiter, warnings);
    }
    const entries = finalize(parsed.items, warnings);
    if (!entries.length) {
      throw new Error(['No questions with a correct answer were found.'].concat(warnings).join(' '));
    }
    return { entries, warnings, format: parsed.format };
  }

  // ---------------------------------------------------------------- tables

  /** Lenient RFC 4180 parser; quotes are only special at the start of a field. */
  function parseDelimited(text, delimiter) {
    const quotes = delimiter !== '|';
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let fieldStart = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"' && fieldStart && quotes) {
        inQuotes = true;
        fieldStart = false;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
        fieldStart = true;
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        fieldStart = true;
      } else {
        field += ch;
        fieldStart = false;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /** Picks the delimiter that splits most lines into a consistent number of columns. */
  function detectDelimiter(text) {
    let best = null;
    let bestScore = 0;
    for (const d of ['\t', '|', ';', ',']) {
      const rows = parseDelimited(text, d)
        .slice(0, 40)
        .map((r) => trimEnd(r.map(T.clean)))
        .filter((r) => r.length);
      if (!rows.length) continue;
      const widths = rows.map((r) => r.length).filter((w) => w >= 2);
      if (widths.length / rows.length < 0.5) continue;
      const counts = new Map();
      for (const w of widths) counts.set(w, (counts.get(w) || 0) + 1);
      const score = (widths.length + Math.max(...counts.values())) / (2 * rows.length);
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    return best;
  }

  function fromTable(rawRows, delimiter, warnings) {
    const rows = rawRows.map((r) => trimEnd(r.map(T.clean))).filter((r) => r.length);
    const name = { '\t': 'spreadsheet cells', '|': '“Question | Answer” lines', ';': 'CSV', ',': 'CSV' }[delimiter];
    const header = findHeader(rows);
    if (header) return { format: `${name} with a header row`, items: fromHeaderRows(rows, header, warnings) };
    return { format: name, items: fromPlainRows(rows, warnings) };
  }

  function columnKind(cell) {
    const c = cell.toLowerCase();
    if (!c) return null;
    if (c === 'q') return 'question';
    // Short choice headers: "A", "B", "A1", "Opt 2", "Choice C".
    if (/^[a-h]$/.test(c) || /^(?:a|ans|answer|opt|option|choice)\s*[#.]?\s*(?:[1-9]|[a-h])$/.test(c)) return 'answer';
    if (/\bcorrect\b|\bright answers?\b|\bsolution\b|\banswer key\b/.test(c)) return 'correct';
    if (/\b(explanation|image|picture|media|time|timer|seconds?|points?|type|feedback|hint|link|url|id)\b/.test(c)) return 'other';
    if (/\b(incorrect|wrong|false|distractors?)\b/.test(c)) return 'wrong';
    if (/^(?:question\s*)?(?:#|no\.?|nr\.?|num(?:ber)?)$/.test(c) || /^question\s*(?:#|no\b|num)/.test(c)) return 'number';
    if (/\b(question|prompt|term|front)\b/.test(c)) return 'question';
    if (/\b(answer|option|choice|alternative)s?\b/.test(c)) return 'answer';
    if (/\b(definition|back|meaning)\b/.test(c)) return 'definition';
    return null;
  }

  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const kinds = rows[i].map(columnKind);
      const hasAnswerInfo = kinds.some((k) => k === 'correct' || k === 'answer' || k === 'wrong' || k === 'definition');
      if (kinds.includes('question') && hasAnswerInfo) return { row: i, kinds };
    }
    return null;
  }

  function fromHeaderRows(rows, header, warnings) {
    const { kinds } = header;
    const columns = (kind) => kinds.reduce((acc, k, i) => (k === kind ? acc.concat(i) : acc), []);
    const qCol = kinds.indexOf('question');
    const numberCol = kinds.indexOf('number');
    const wrongCols = columns('wrong');
    let answerCols = columns('answer');
    let correctCol = kinds.indexOf('correct');
    // "indexed": answer columns hold every choice and the correct column says which (number,
    // letter or text) - Blooket, Kahoot and Quizizz templates. "text": the correct column holds
    // the answer itself, optionally with wrong-answer columns - Gimkit template, Question/Answer.
    let mode = 'indexed';
    if (correctCol < 0) {
      mode = 'text';
      if (kinds.indexOf('definition') >= 0) correctCol = kinds.indexOf('definition');
      else if (answerCols.length === 1) correctCol = answerCols.pop();
    } else if (answerCols.length < 2) {
      mode = 'text';
    }
    if (correctCol < 0) {
      warnings.push('No column with the correct answer was found - add one named “Correct answer”.');
      return [];
    }
    const items = [];
    rows.slice(header.row + 1).forEach((row, i) => {
      const number = numberCol >= 0 && /^\d+$/.test(row[numberCol] || '') ? Number(row[numberCol]) : i + 1;
      const question = row[qCol] || '';
      const cell = row[correctCol] || '';
      if (mode === 'indexed') {
        const options = answerCols.map((c) => row[c] || '');
        items.push(Object.assign({ question, options, ordered: true, n: number }, interpretCorrect(cell, options)));
      } else {
        const wrong = wrongCols.concat(answerCols).map((c) => row[c] || '').filter(Boolean);
        items.push({ question, options: cell ? [cell].concat(wrong) : wrong, correct: cell ? [cell] : [], n: number });
      }
    });
    return items;
  }

  function fromPlainRows(rows, warnings) {
    const width = mostCommon(rows.map((r) => r.length));
    const numbered = width >= 3 && rows.every((r) => !r[0] || /^\d+$/.test(r[0]));
    const start = numbered ? 1 : 0;
    const items = [];
    if (width - start <= 2) {
      for (const r of rows) items.push({ question: r[start] || '', correct: r[start + 1] ? [r[start + 1]] : [] });
      return items;
    }
    warnings.push('No header row found, so each row was read as: question, answer choices…, correct answer.');
    for (const r of rows) {
      const cells = r.slice(start);
      if (cells.length <= 2) {
        items.push({ question: cells[0] || '', correct: cells[1] ? [cells[1]] : [] });
        continue;
      }
      const options = cells.slice(1, -1);
      items.push(Object.assign({ question: cells[0], options, ordered: true }, interpretCorrect(cells[cells.length - 1], options)));
    }
    return items;
  }

  /** Reads a "correct answer" cell: answer number(s) like "2" or "1, 3", the answer text, or letter(s). */
  function interpretCorrect(cell, options) {
    if (!cell) return { correct: [], correctIdx: [] };
    const usable = (i) => i >= 0 && i < options.length && !!options[i];
    const tokens = cell.split(/\s*(?:[,;/&+]|\band\b|\s)\s*/i).filter(Boolean);
    if (tokens.length && tokens.every((t) => /^\d+$/.test(t) && usable(Number(t) - 1))) {
      return { correct: [], correctIdx: tokens.map((t) => Number(t) - 1) };
    }
    const exact = options.findIndex((o) => o && T.strict(o) === T.strict(cell));
    if (exact >= 0) return { correct: [], correctIdx: [exact] };
    const letter = (t) => t.toLowerCase().charCodeAt(0) - 97;
    if (tokens.length && tokens.every((t) => /^[a-h]$/i.test(t) && usable(letter(t)))) {
      return { correct: [], correctIdx: tokens.map(letter) };
    }
    return { correct: [cell], correctIdx: [] };
  }

  // ------------------------------------------------------------- Q:/A: lines

  const Q_LINE = /^\s*(?:q|question)\s*\d*\s*:\s*/i;
  const A_LINE = /^\s*(?:a|answer|correct(?:\s+answer)?)\s*:\s*/i;

  function looksLikeQaLines(text) {
    const lines = text.split('\n');
    return lines.some((l) => Q_LINE.test(l)) && lines.some((l) => A_LINE.test(l));
  }

  function fromQaLines(text) {
    const items = [];
    let current = null;
    let target = null;
    for (const line of text.split('\n')) {
      if (Q_LINE.test(line)) {
        current = { question: line.replace(Q_LINE, ''), correct: [] };
        items.push(current);
        target = 'q';
      } else if (current && A_LINE.test(line)) {
        current.correct.push(line.replace(A_LINE, ''));
        target = 'a';
      } else if (!line.trim()) {
        target = null;
      } else if (current && target === 'q') {
        current.question += ' ' + line.trim();
      } else if (current && target === 'a') {
        current.correct[current.correct.length - 1] += ' ' + line.trim();
      }
    }
    return items;
  }

  // -------------------------------------------------------------------- JSON

  const QUESTION_KEYS = ['question', 'questionText', 'question_text', 'q', 'prompt', 'term', 'front', 'title', 'text'];
  const CHOICE_KEYS = ['choices', 'answers', 'options', 'alternatives'];
  const CORRECT_KEYS = ['correctAnswers', 'correct_answers', 'correctAnswer', 'correct_answer', 'correct', 'answer', 'definition', 'solution', 'back'];
  const INDEX_KEYS = ['correctIndex', 'correct_index', 'correctIndexes', 'correctIndices', 'answerIndex', 'answer_index'];
  const CONTAINER_KEYS = ['questions', 'items', 'cards', 'terms', 'entries', 'data', 'quiz', 'kahoot', 'set', 'game', 'deck'];

  function fromJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('That looks like JSON but it couldn’t be read: ' + err.message);
    }
    const items = [];
    walkJson(data, 0, 0, items);
    if (!items.length && data && typeof data === 'object' && !Array.isArray(data)) {
      // A plain {"question": "answer"} map.
      for (const [question, answer] of Object.entries(data)) {
        if (typeof answer === 'string' || typeof answer === 'number') items.push({ question, correct: [String(answer)] });
      }
    }
    for (const item of items) {
      item.question = T.htmlToText(item.question);
      item.options = (item.options || []).map(T.htmlToText);
      item.correct = (item.correct || []).map(T.htmlToText);
    }
    return { format: 'JSON', items };
  }

  function walkJson(node, depth, position, items) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walkJson(child, depth + 1, i + 1, items));
      return;
    }
    const item = jsonItem(node);
    if (item) {
      if (position) item.n = position;
      items.push(item);
      return;
    }
    for (const key of CONTAINER_KEYS) {
      if (node[key] && typeof node[key] === 'object') walkJson(node[key], depth + 1, 0, items);
    }
  }

  function firstText(obj, keys) {
    for (const key of keys) {
      const v = obj[key];
      if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v);
    }
    return '';
  }

  function jsonItem(obj) {
    const question = firstText(obj, QUESTION_KEYS);
    if (!question) return null;
    const list = CHOICE_KEYS.map((k) => obj[k]).find(Array.isArray);
    const hasAnswer =
      list ||
      CORRECT_KEYS.some((k) => obj[k] != null && typeof obj[k] !== 'boolean') ||
      INDEX_KEYS.some((k) => obj[k] != null);
    if (!hasAnswer) return null;
    const options = [];
    const correct = [];
    const correctIdx = [];
    (list || []).forEach((choice, i) => {
      if (choice && typeof choice === 'object') {
        options.push(firstText(choice, ['answer', 'text', 'value', 'label', 'option', 'title']));
        if (choice.correct === true || choice.isCorrect === true || choice.is_correct === true) correctIdx.push(i);
      } else {
        options.push(choice == null ? '' : String(choice));
      }
    });
    for (const key of CORRECT_KEYS) {
      for (const v of [].concat(obj[key])) {
        if (typeof v === 'string' || typeof v === 'number') correct.push(String(v));
      }
    }
    for (const key of INDEX_KEYS) {
      for (const v of [].concat(obj[key])) {
        if (Number.isInteger(v)) correctIdx.push(v);
      }
    }
    if (!correct.length && !correctIdx.length && options.length === 1) correct.push(options[0]);
    return { question, options, correct, correctIdx, ordered: !!list };
  }

  // ----------------------------------------------------------------- shared

  function finalize(items, warnings) {
    const entries = [];
    const byKey = new Map();
    let skipped = 0;
    items.forEach((item, i) => {
      const q = T.clean(item.question);
      const options = trimEnd((item.options || []).map(T.clean));
      const correct = [];
      const correctIdx = [];
      const addCorrect = (text) => {
        if (text && !correct.some((c) => T.strict(c) === T.strict(text))) correct.push(text);
      };
      for (const idx of item.correctIdx || []) {
        if (!options[idx]) continue;
        if (!correctIdx.includes(idx)) correctIdx.push(idx);
        addCorrect(options[idx]);
      }
      for (const c of item.correct || []) addCorrect(T.clean(c));
      if (item.ordered && !correctIdx.length) {
        options.forEach((o, idx) => {
          if (o && correct.some((c) => T.strict(c) === T.strict(o))) correctIdx.push(idx);
        });
      }
      if (!q || !correct.length) {
        if (q || correct.length) skipped++;
        return;
      }
      const key = T.strict(q) + '\u0000' + options.map(T.strict).join('\u0001');
      const existing = byKey.get(key);
      if (existing) {
        for (const c of correct) if (!existing.correct.some((e) => T.strict(e) === T.strict(c))) existing.correct.push(c);
        for (const idx of correctIdx) if (!existing.correctIdx.includes(idx)) existing.correctIdx.push(idx);
        return;
      }
      const entry = { q, options, correct, correctIdx, n: item.n || i + 1 };
      byKey.set(key, entry);
      entries.push(entry);
    });
    if (skipped) {
      warnings.push(`${skipped} row${skipped === 1 ? ' was' : 's were'} skipped because the question or its correct answer was missing.`);
    }
    return entries;
  }

  function trimEnd(cells) {
    let end = cells.length;
    while (end > 0 && !cells[end - 1]) end--;
    return cells.slice(0, end);
  }

  function mostCommon(values) {
    const counts = new Map();
    let best = 0;
    let bestCount = 0;
    for (const v of values) {
      const c = (counts.get(v) || 0) + 1;
      counts.set(v, c);
      if (c > bestCount || (c === bestCount && v > best)) {
        best = v;
        bestCount = c;
      }
    }
    return best;
  }

  return { parseAnswerKey, parseDelimited, detectDelimiter };
});
