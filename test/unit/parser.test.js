'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerKey, detectDelimiter } = require('../../extension/src/lib/parser.js');

const simple = (entries) => entries.map((e) => [e.q, e.correct]);

test('“Question | Answer” lines', () => {
  const { entries, format } = parseAnswerKey(
    'What is the capital of France? | Paris\nWhich of these, if any, is a mammal? | Whale\n\nTranslate "gato" | Cat\n'
  );
  assert.match(format, /Question \| Answer/);
  assert.deepEqual(simple(entries), [
    ['What is the capital of France?', ['Paris']],
    ['Which of these, if any, is a mammal?', ['Whale']],
    ['Translate "gato"', ['Cat']],
  ]);
});

test('Blooket import template (CSV with multi-line header cells)', () => {
  const csv = [
    '"Blooket\nImport Template",,,,,,,',
    'Question #,Question Text,Answer 1,Answer 2,"Answer 3\n(Optional)","Answer 4\n(Optional)","Time Limit (sec)\n(Max: 300 seconds)","Correct Answer(s)\n(Only include Answer #)"',
    '1,What is the capital of France?,Paris,London,Berlin,Madrid,20,1',
    '2,Which numbers are even?,2,3,4,5,20,"1,3"',
    '3,"Is ""quoted"" text, with commas, ok?",Yes,No,,,20,1',
    '4,,,,,,,',
    '5,,,,,,,',
  ].join('\r\n');
  const { entries, warnings } = parseAnswerKey(csv);
  assert.deepEqual(warnings, []);
  assert.deepEqual(entries, [
    { q: 'What is the capital of France?', options: ['Paris', 'London', 'Berlin', 'Madrid'], correct: ['Paris'], correctIdx: [0], n: 1 },
    { q: 'Which numbers are even?', options: ['2', '3', '4', '5'], correct: ['2', '4'], correctIdx: [0, 2], n: 2 },
    { q: 'Is "quoted" text, with commas, ok?', options: ['Yes', 'No'], correct: ['Yes'], correctIdx: [0], n: 3 },
  ]);
});

test('Kahoot import template (CSV export with preamble rows)', () => {
  const csv = [
    ',,,,,,,',
    ',Quiz template,,,,,,',
    ',"Add questions, at least two answer alternatives, time limit and choose correct answers (at least one).",,,,,,',
    ',"See an example question below (don\'t forget to overwrite this with your first question!)",,,,,,',
    ',,,,,,,',
    ',Question - max 120 characters,Answer 1 - max 75 characters,Answer 2 - max 75 characters,Answer 3 - max 75 characters,Answer 4 - max 75 characters,"Time limit (sec) – 5, 10, 20, 30, 60, 90, 120, or 240 secs",Correct answer(s) - choose at least one',
    '1,Which ocean is the largest?,Atlantic,Pacific,Indian,Arctic,20,2',
    '2,Select the prime numbers,2,4,5,9,30,"1,3"',
    '3,The Sun is a star.,True,False,,,10,1',
  ].join('\n');
  const { entries } = parseAnswerKey(csv);
  assert.deepEqual(
    entries.map((e) => [e.q, e.correct, e.correctIdx, e.n]),
    [
      ['Which ocean is the largest?', ['Pacific'], [1], 1],
      ['Select the prime numbers', ['2', '5'], [0, 2], 2],
      ['The Sun is a star.', ['True'], [0], 3],
    ]
  );
});

test('cells pasted from Google Sheets (tab separated, quoted cell with newline)', () => {
  const tsv = 'Question\tAnswer 1\tAnswer 2\tAnswer 3\tAnswer 4\tCorrect\n"Two\nlines?"\tA1\tA2\tA3\tA4\tC\nWhat is 3 x 3?\t6\t9\t12\t3\t9\n';
  const { entries, format } = parseAnswerKey(tsv);
  assert.match(format, /spreadsheet cells with a header row/);
  assert.deepEqual(simple(entries), [
    ['Two lines?', ['A3']],
    ['What is 3 x 3?', ['9']],
  ]);
});

test('Gimkit template: correct answer text plus incorrect-answer columns', () => {
  const csv = 'Gimkit Spreadsheet Import Template,,,,\nQuestion,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)\nWhat is 2+2?,4,3,5,22\n';
  const { entries } = parseAnswerKey(csv);
  assert.deepEqual(entries, [{ q: 'What is 2+2?', options: ['4', '3', '5', '22'], correct: ['4'], correctIdx: [], n: 1 }]);
});

test('Quizizz template: ignores type, time and explanation columns', () => {
  const csv =
    'Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation\n' +
    'What is 2+2?,Multiple Choice,3,4,5,6,,2,30,,Because math\n';
  const { entries } = parseAnswerKey(csv);
  assert.deepEqual(simple(entries), [['What is 2+2?', ['4']]]);
});

test('correct column given as text or letters', () => {
  const csv = 'Question,Option A,Option B,Option C,Correct answer\nPick blue,Red,Blue,Green,blue\nPick green,Red,Blue,Green,C\nNot listed,Red,Blue,Green,Purple\n';
  const { entries } = parseAnswerKey(csv);
  assert.deepEqual(
    entries.map((e) => [e.q, e.correct, e.correctIdx]),
    [
      ['Pick blue', ['Blue'], [1]],
      ['Pick green', ['Green'], [2]],
      ['Not listed', ['Purple'], []],
    ]
  );
});

test('two columns without a header (e.g. a Quizlet export)', () => {
  const { entries } = parseAnswerKey('perro\tdog\ngato\tcat\n');
  assert.deepEqual(simple(entries), [
    ['perro', ['dog']],
    ['gato', ['cat']],
  ]);
});

test('Q:/A: lines, with multi-line questions and several accepted answers', () => {
  const text = 'Q: What is 7 × 8?\nA: 56\n\nQuestion: Name a primary\ncolour\nAnswer: Red\nAnswer: Blue\n';
  const { entries, format } = parseAnswerKey(text);
  assert.equal(format, 'Q:/A: lines');
  assert.deepEqual(simple(entries), [
    ['What is 7 × 8?', ['56']],
    ['Name a primary colour', ['Red', 'Blue']],
  ]);
});

test('JSON: simple list, choice objects with HTML, correctAnswers and a plain map', () => {
  assert.deepEqual(simple(parseAnswerKey('[{"question": "2+2?", "answer": 4}]').entries), [['2+2?', ['4']]]);

  const kahootLike = JSON.stringify({
    title: 'My quiz',
    questions: [
      { type: 'content', title: 'Welcome!' },
      {
        question: 'What is <b>H<sub>2</sub>O</b>&nbsp;called?',
        choices: [
          { answer: 'Salt', correct: false },
          { answer: 'Water', correct: true },
        ],
      },
    ],
  });
  const kahoot = parseAnswerKey(kahootLike).entries;
  assert.deepEqual(kahoot, [{ q: 'What is H2O called?', options: ['Salt', 'Water'], correct: ['Water'], correctIdx: [1], n: 2 }]);

  const blooketLike = JSON.stringify({ questions: [{ question: 'Pick one', answers: ['a', 'b', 'c'], correctAnswers: ['c'] }] });
  assert.deepEqual(parseAnswerKey(blooketLike).entries[0].correctIdx, [2]);

  assert.deepEqual(simple(parseAnswerKey('{"Capital of Italy?": "Rome"}').entries), [['Capital of Italy?', ['Rome']]]);
});

test('duplicate questions merge their accepted answers', () => {
  const { entries } = parseAnswerKey('Name a primary colour | Red\nName a primary colour | Blue\nname a primary colour | red');
  assert.deepEqual(simple(entries), [['Name a primary colour', ['Red', 'Blue']]]);
});

test('reports rows without an answer and fails on unusable input', () => {
  const { entries, warnings } = parseAnswerKey('Question,Answer\nHas answer,Yes\nNo answer here,\n');
  assert.equal(entries.length, 1);
  assert.match(warnings[0], /1 row was skipped/);

  assert.throws(() => parseAnswerKey('   '), /Paste an answer key/);
  assert.throws(() => parseAnswerKey('just some words'), /recognise the format/);
  assert.throws(() => parseAnswerKey('{"oops": '), /JSON/);
  assert.throws(() => parseAnswerKey('Question,Answer 1,Answer 2\nQ,a,b\n'), /correct answer/i);
});

test('delimiter detection prefers the consistent split', () => {
  assert.equal(detectDelimiter('a | b, c\nd | e, f, g'), '|');
  assert.equal(detectDelimiter('q;"a, b";c\nq2;d;e'), ';');
  assert.equal(detectDelimiter('q\ta\nq2\tb'), '\t');
});
