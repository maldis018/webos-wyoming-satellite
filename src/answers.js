'use strict';
/*
 * Shown or spoken: what happens to the answer of a run.
 *
 *   new Satellite({ speakAnswer: speakPolicy('auto', 80), ... });
 *   showAnswers(satellite);   // every answer (and a failed run) as a toast on the tv
 *
 * speakPolicy(mode, over) returns the satellite's `speakAnswer({ text, heard })`:
 *   'always'  every answer is spoken (the satellite's default)
 *   'never'   none is
 *   'auto'    a question is answered aloud, and so is any reply longer than `over` characters; a short reply to a
 *             command ("Turned off the light") is only shown
 *
 * A toast is `com.webos.notification/createToast`, which root may call with any sourceId.
 */
const TOAST = 'com.webos.notification/createToast';
const SOURCE_ID = 'com.webos.service.secondscreen.gateway';
const MAX_TOAST_CHARS = 250;
const QUESTION_START = /^(what|what's|whats|who|who's|whom|whose|where|where's|when|why|how|how's|which|is|are|am|was|were|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|tell me|explain|describe)\b/i;

// Whether what was heard is a question: a question mark, or a sentence that opens like one.
function isQuestion(heard) {
  const t = String(heard || '').trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return QUESTION_START.test(t.replace(/^(hey|ok|okay|so|and|um|uh)[,\s]+/i, ''));
}

function speakPolicy(mode, over) {
  if (mode === 'never') return () => false;
  if (mode !== 'auto') return () => true;
  const limit = over === undefined ? 80 : over;
  return ({ text, heard }) => isQuestion(heard) || String(text || '').length > limit;
}

// What a failed run says on screen. HA's codes are for logs, not for people.
function errorMessage({ code, text }) {
  if (code === 'stt-no-text-recognized') return 'Sorry, I didn\'t catch that.';
  if (code === 'stt-stream-failed' || code === 'stt-provider-unsupported-metadata') return 'Speech recognition is not available right now.';
  if (code === 'intent-failed') return 'Sorry, something went wrong with that request.';
  return text ? String(text) : 'Sorry, that did not work.';
}

function clip(s) {
  s = String(s || '').trim();
  return s.length > MAX_TOAST_CHARS ? s.slice(0, MAX_TOAST_CHARS - 1) + '…' : s;
}

function showAnswers(sat, opts = {}) {
  const log = opts.log || sat.log || (() => {});
  const toast = (message) => {
    if (!message) return;
    sat.luna.call(TOAST, { sourceId: SOURCE_ID, message: clip(message) }, (err) => {
      if (err) log('warn', 'answers: toast failed: ' + err.message);
    });
  };
  const onAnswer = ({ text, heard, spoken }) => {
    log('info', 'answers: "' + heard + '" -> "' + text + '"' + (spoken ? ' (spoken)' : ' (shown)'));
    toast(text);
  };
  const onError = (e) => {
    log('info', 'answers: run failed (' + (e.code || 'no code') + ': ' + (e.text || '') + ')');
    toast(errorMessage(e));
  };
  sat.on('answer', onAnswer);
  sat.on('pipeline-error', onError);
  return { stop() { sat.removeListener('answer', onAnswer); sat.removeListener('pipeline-error', onError); } };
}

module.exports = { speakPolicy, showAnswers, isQuestion, errorMessage };
