'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../extension/src/lib/text.js');
const { parseAnswerKey } = require('../../extension/src/lib/parser.js');
const { KeyIndex, solve, findOption } = require('../../extension/src/lib/matcher.js');

function indexOf(...keys) {
  return new KeyIndex(keys.map((text, i) => ({ id: `set${i}`, name: `Key ${i}`, entries: parseAnswerKey(text).entries })));
}

const BLOCKS = (...texts) => texts.map((t) => (typeof t === 'string' ? { text: t, weight: 16, clickable: false } : t));

test('normalisation keeps meaningful symbols but ignores formatting', () => {
  assert.equal(T.strict('  What’s  7 × 8? '), "what's 7 x 8?");
  assert.equal(T.strict('−5'), '-5');
  assert.equal(T.loose('Café, “quoted”!'), 'cafe quoted');
  assert.equal(T.questionFingerprint('Question 3 of 10: What is X?').strict, 'what is x?');
  assert.equal(T.questionFingerprint('1984 was written by?').strict, '1984 was written by?');
  assert.equal(T.optionFingerprint('B) Paris').bare, 'paris');
});

test('exact match on the site’s question element, answers in any order', () => {
  const index = indexOf('What is the capital of France? | Paris');
  const result = solve(index, { questions: ['What is the capital of FRANCE'], options: ['Rome', 'Madrid', 'Paris', 'Berlin'] });
  assert.equal(result.ok, true);
  assert.equal(result.how, 'exact');
  assert.deepEqual(result.optionTargets, [2]);
});

test('“-5” and “5” are different answers', () => {
  const index = indexOf('What is −5 + 10? | 5', 'What is 5 - 10? | -5');
  assert.deepEqual(solve(index, { questions: ['What is -5 + 10?'], options: ['-5', '5', '15', '-15'] }).optionTargets, [1]);
  assert.deepEqual(solve(index, { questions: ['What is 5 − 10?'], options: ['5', '-5', '15', '-15'] }).optionTargets, [1]);
});

test('close matches allow typos but not different numbers or negations', () => {
  const index = indexOf(
    'Which planet is known as the Red Planet? | Mars\nWhat is 7 x 8? | 56\nWhich animal is a mammal? | Whale'
  );
  const typo = solve(index, { questions: ['Which planet is know as the Red Planet'], options: ['Venus', 'Mars', 'Jupiter', 'Saturn'] });
  assert.equal(typo.how, 'fuzzy');
  assert.deepEqual(typo.optionTargets, [1]);

  const numbers = solve(index, { questions: ['What is 7 x 9?'], options: ['56', '63', '72', '81'] });
  assert.equal(numbers.ok, false);

  const negated = solve(index, { questions: ['Which animal is not a mammal?'], options: ['Whale', 'Shark', 'Dog', 'Cat'] });
  assert.equal(negated.ok, false);

  const off = solve(index, { questions: ['Which planet is know as the Red Planet'], options: ['Venus', 'Mars'] }, { fuzzy: false });
  assert.equal(off.ok, false);
});

test('a close match must share the answer choices of the key', () => {
  const index = indexOf(
    'Question,A1,A2,A3,A4,Correct\nWhich of the following cities is the capital of Spain in Europe?,Madrid,Barcelona,Seville,Valencia,1\n'
  );
  const result = solve(index, {
    questions: ['Which of the following cities is the capital of France in Europe?'],
    options: ['Paris', 'Lyon', 'Madrid', 'Rome'],
  });
  assert.equal(result.ok, false);
});

test('an exact question whose answer isn’t shown yet waits instead of guessing', () => {
  const index = indexOf('What is the capital of France? | Paris');
  const result = solve(index, { questions: ['What is the capital of France?'], options: ['Lyon', 'Nice'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'answer-not-found');
});

test('answer labels and extra text around the answer', () => {
  const choices = ['A) London', 'B) Paris', 'C) Rome'].map(T.optionFingerprint);
  assert.equal(findOption(T.optionFingerprint('Paris'), choices), 1);
  const decorated = ['Triangle Lyon', 'Diamond Paris'].map(T.optionFingerprint);
  assert.equal(findOption(T.optionFingerprint('Paris'), decorated), 1);
  assert.equal(findOption(T.optionFingerprint('5'), ['15 apples', '5 apples'].map(T.optionFingerprint)), 1);
});

test('question found by its answer choices when its text isn’t visible', () => {
  const index = indexOf('Question,Answer 1,Answer 2,Answer 3,Answer 4,Correct\nLargest ocean?,Atlantic,Pacific,Indian,Arctic,2\n');
  const result = solve(index, { questions: [], options: ['Arctic', 'Indian', 'Pacific', 'Atlantic'] });
  assert.equal(result.how, 'options');
  assert.deepEqual(result.optionTargets, [2]);
});

test('identical answer choices with different correct answers are skipped', () => {
  const index = indexOf('Question,A1,A2,Correct\nThe sun is a star.,True,False,1\nThe moon is a star.,True,False,2\n');
  const result = solve(index, { questions: [], options: ['True', 'False'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  // ...unless the question text is visible
  assert.deepEqual(solve(index, { questions: ['The moon is a star.'], options: ['True', 'False'] }).optionTargets, [1]);
});

test('duplicate questions are disambiguated by the answer choices on screen', () => {
  const index = indexOf(
    'Question,A1,A2,A3,Correct\nWhich is a fruit?,Apple,Carrot,Potato,1\n',
    'Question,A1,A2,A3,Correct\nWhich is a fruit?,Onion,Banana,Leek,2\n'
  );
  assert.deepEqual(solve(index, { questions: ['Which is a fruit?'], options: ['Leek', 'Onion', 'Banana'] }).optionTargets, [2]);
});

test('Kahoot without text on the device: question number + answer position', () => {
  const kahoot = indexOf('Question,Answer 1,Answer 2,Answer 3,Answer 4,Correct\nQ1,a,b,c,d,2\nQ2,a,b,c,d,4\n');
  const view = { questions: [], options: ['', '', '', ''], optionKeys: [0, 1, 2, 3], questionNumber: 2 };
  const result = solve(kahoot, view);
  assert.equal(result.how, 'number');
  assert.deepEqual(result.optionTargets, [3]);

  // With several keys it only works once it knows which key this game uses.
  const two = indexOf('Question,Answer 1,Answer 2,Correct\nQ1,a,b,1\n', 'Question,Answer 1,Answer 2,Correct\nQ1,a,b,2\n');
  const blind = { questions: [], options: ['', ''], optionKeys: [0, 1], questionNumber: 1 };
  assert.equal(solve(two, blind).reason, 'no-text');
  assert.deepEqual(solve(two, Object.assign({ preferredSetId: 'set1' }, blind)).optionTargets, [1]);
});

test('generic pages: question and clickable answer found by text', () => {
  const index = indexOf('What is H2O commonly called? | Water');
  const view = {
    blocks: BLOCKS(
      'My Practice Game',
      { text: 'What is H2O commonly called?', weight: 24, clickable: false },
      { text: 'Water', weight: 12, clickable: false }, // legend text, not a button
      { text: 'A) Salt', clickable: true },
      { text: 'B) Water', clickable: true },
      { text: 'C) Oxygen', clickable: true }
    ),
  };
  const result = solve(index, view);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockTargets, [4]);
});

test('generic pages: an answer choice that is also a question in the key does not confuse it', () => {
  const index = indexOf('France | Paris\nParis | France');
  const view = {
    blocks: BLOCKS(
      { text: 'France', weight: 28, clickable: false },
      { text: 'Paris', clickable: true },
      { text: 'Rome', clickable: true }
    ),
  };
  const result = solve(index, view);
  assert.equal(result.ok, true);
  assert.equal(result.entry.q, 'France');
  assert.deepEqual(result.blockTargets, [1]);
});

test('disabled answer keys are ignored', () => {
  const index = new KeyIndex([
    { id: 'a', name: 'A', enabled: false, entries: parseAnswerKey('Q? | Yes').entries },
    { id: 'b', name: 'B', entries: [] },
  ]);
  assert.equal(index.size, 0);
  assert.equal(solve(index, { questions: ['Q?'], options: ['Yes', 'No'] }).reason, 'no-keys');
});
