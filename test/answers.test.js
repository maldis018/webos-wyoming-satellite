'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { speakPolicy, isQuestion, errorMessage } = require('../src/answers');

test('isQuestion: a question mark or a question opening', () => {
  for (const q of ['What is the weather?', 'how warm is it outside', 'Is the front door locked', 'Hey, what time is it', 'tell me a joke', 'Can you dim the lamp?'])
    assert.equal(isQuestion(q), true, q);
  for (const c of ['Turn off the office lamp.', 'set the lamp to 50 percent', 'Lock the door', '', null, 'Isolate nothing'])
    assert.equal(isQuestion(c), false, String(c));
});

test('speakPolicy auto: questions and long replies are spoken, short replies to commands are not', () => {
  const auto = speakPolicy('auto', 40);
  assert.equal(auto({ heard: 'Turn off the office lamp.', text: 'Turned off the light' }), false);
  assert.equal(auto({ heard: 'What is the weather?', text: 'Sunny' }), true);
  assert.equal(auto({ heard: 'Turn on everything', text: 'x'.repeat(41) }), true);
  assert.equal(speakPolicy('never')({ heard: 'what?', text: 'y'.repeat(500) }), false);
  assert.equal(speakPolicy('always')({ heard: 'off', text: 'ok' }), true);
});

test('errorMessage turns HA codes into something to read', () => {
  assert.equal(errorMessage({ code: 'stt-no-text-recognized', text: 'No text recognized' }), 'Sorry, I didn\'t catch that.');
  assert.equal(errorMessage({ code: 'other', text: 'Boom' }), 'Boom');
  assert.ok(errorMessage({}).length > 0);
});
