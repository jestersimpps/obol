const { describe, it, expect } = globalThis;

const { buildTranscript } = require('../src/analysis');

describe('analysis', () => {
  describe('buildTranscript', () => {
    it('formats messages with timestamp and role', () => {
      const messages = [
        { role: 'user', content: 'hello', created_at: '2024-01-15T20:00:00.000Z' },
        { role: 'assistant', content: 'hi there', created_at: '2024-01-15T20:01:00.000Z' },
      ];

      const result = buildTranscript(messages);

      expect(result).toContain('USER: hello');
      expect(result).toContain('ASSISTANT: hi there');
    });

    it('truncates message content at 1000 chars', () => {
      const longContent = 'x'.repeat(2000);
      const messages = [
        { role: 'user', content: longContent, created_at: '2024-01-15T20:00:00.000Z' },
      ];

      const result = buildTranscript(messages);

      expect(result).toContain('x'.repeat(1000));
      expect(result).not.toContain('x'.repeat(1001));
    });

    it('stops adding messages once transcript exceeds 40000 chars', () => {
      const bigContent = 'x'.repeat(1000);
      const messages = Array.from({ length: 50 }, (_, i) => ({
        role: 'user',
        content: bigContent,
        created_at: new Date(Date.now() + i * 1000).toISOString(),
      }));

      const result = buildTranscript(messages);

      expect(result.length).toBeLessThanOrEqual(42000);
    });

    it('returns empty string for empty messages array', () => {
      expect(buildTranscript([])).toBe('');
    });

    it('trims trailing whitespace', () => {
      const messages = [
        { role: 'user', content: 'hello', created_at: '2024-01-15T20:00:00.000Z' },
      ];

      const result = buildTranscript(messages);

      expect(result).not.toMatch(/\s+$/);
    });
  });
});
