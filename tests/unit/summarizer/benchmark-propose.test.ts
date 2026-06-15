import { describe, expect, it } from 'vitest';
import { parseProposedCase } from '../../../src/summarizer/benchmark-propose.js';

describe('parseProposedCase', () => {
  it('parses a valid bare JSON object', () => {
    const raw = JSON.stringify({
      name: 'Topic wording',
      question: 'role 和 topic 有什么区别？',
      expectedTruth: 'topic 是知识集合的新叫法，取代旧的 role 措辞。',
    });
    expect(parseProposedCase(raw)).toEqual({
      name: 'Topic wording',
      question: 'role 和 topic 有什么区别？',
      expectedTruth: 'topic 是知识集合的新叫法，取代旧的 role 措辞。',
    });
  });

  it('parses fenced ```json blocks with surrounding prose', () => {
    const raw = [
      'Here is the case:',
      '```json',
      '{ "name": "X", "question": "How do I do X?", "expectedTruth": "Run X." }',
      '```',
      'Hope that helps!',
    ].join('\n');
    expect(parseProposedCase(raw)).toEqual({
      name: 'X',
      question: 'How do I do X?',
      expectedTruth: 'Run X.',
    });
  });

  it('returns null when a required field is missing', () => {
    expect(parseProposedCase('{ "name": "X", "question": "Q?" }')).toBeNull();
  });

  it('returns null when a required field is empty/whitespace', () => {
    const raw = '{ "name": "X", "question": "   ", "expectedTruth": "Y" }';
    expect(parseProposedCase(raw)).toBeNull();
  });

  it('returns null for non-JSON input', () => {
    expect(parseProposedCase('sorry, I cannot help with that')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseProposedCase('{ "name": "X", "question": ')).toBeNull();
  });
});
