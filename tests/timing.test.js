const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

const { resolveDelay, extractPeakHour } = require('../src/utils/timing');

describe('timing', () => {
  describe('extractPeakHour', () => {
    it('extracts hour from peak_hours range', () => {
      expect(extractPeakHour({ peak_hours: ['19:00-22:00'] })).toBe(19);
    });

    it('extracts hour from simple time string', () => {
      expect(extractPeakHour({ peak_hours: ['21:00'] })).toBe(21);
    });

    it('defaults to 20 when no data', () => {
      expect(extractPeakHour(null)).toBe(20);
      expect(extractPeakHour(undefined)).toBe(20);
      expect(extractPeakHour({})).toBe(20);
      expect(extractPeakHour({ peak_hours: [] })).toBe(20);
    });

    it('defaults to 20 on unparseable string', () => {
      expect(extractPeakHour({ peak_hours: ['evening'] })).toBe(20);
    });

    it('handles single-digit hours', () => {
      expect(extractPeakHour({ peak_hours: ['9:00-11:00'] })).toBe(9);
    });
  });

  describe('resolveDelay — legacy numeric', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('parses hours', () => {
      expect(resolveDelay('2h')).toBe(new Date('2024-01-15T14:00:00.000Z').toISOString());
    });

    it('parses days', () => {
      expect(resolveDelay('1d')).toBe(new Date('2024-01-16T12:00:00.000Z').toISOString());
    });

    it('parses weeks', () => {
      expect(resolveDelay('1w')).toBe(new Date('2024-01-22T12:00:00.000Z').toISOString());
    });

    it('ignores timezone and timingData for legacy format', () => {
      const result = resolveDelay('3h', 'America/New_York', { peak_hours: ['19:00-22:00'] });
      expect(result).toBe(new Date('2024-01-15T15:00:00.000Z').toISOString());
    });
  });

  describe('resolveDelay — datetime with time', () => {
    it('converts local datetime to UTC (UTC timezone)', () => {
      const result = resolveDelay('2024-03-15T20:00', 'UTC');
      expect(result).toBe(new Date('2024-03-15T20:00:00.000Z').toISOString());
    });

    it('converts local datetime to UTC (EST = UTC-5)', () => {
      const result = resolveDelay('2024-03-15T20:00', 'America/New_York');
      const due = new Date(result);
      const localHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
          .formatToParts(due)
          .find(p => p.type === 'hour').value
      );
      expect(localHour).toBe(20);
    });

    it('converts local datetime to UTC (JST = UTC+9)', () => {
      const result = resolveDelay('2024-03-15T21:30', 'Asia/Tokyo');
      const due = new Date(result);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(due);
      const localHour = parseInt(parts.find(p => p.type === 'hour').value);
      const localMinute = parseInt(parts.find(p => p.type === 'minute').value);
      expect(localHour).toBe(21);
      expect(localMinute).toBe(30);
    });

    it('handles seconds and extra precision in input', () => {
      const result = resolveDelay('2024-03-15T20:00:00', 'UTC');
      expect(result).toBe(new Date('2024-03-15T20:00:00.000Z').toISOString());
    });
  });

  describe('resolveDelay — date-only snap to peak', () => {
    it('snaps to peak hour with timing data', () => {
      const result = resolveDelay('2024-03-15', 'UTC', { peak_hours: ['19:00-22:00'] });
      expect(result).toBe(new Date('2024-03-15T19:00:00.000Z').toISOString());
    });

    it('snaps to default peak 20 without timing data', () => {
      const result = resolveDelay('2024-03-15', 'UTC', null);
      expect(result).toBe(new Date('2024-03-15T20:00:00.000Z').toISOString());
    });

    it('snaps to peak in user local time (EST)', () => {
      const result = resolveDelay('2024-03-15', 'America/New_York', { peak_hours: ['20:00-23:00'] });
      const due = new Date(result);
      const localHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
          .formatToParts(due)
          .find(p => p.type === 'hour').value
      );
      expect(localHour).toBe(20);
    });
  });

  describe('resolveDelay — fallback', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('unknown input defaults to tomorrow at peak', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

      const result = resolveDelay('whenever', 'UTC', { peak_hours: ['20:00-23:00'] });
      expect(result).toBe(new Date('2024-01-16T20:00:00.000Z').toISOString());
    });

    it('empty string defaults to tomorrow at peak', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

      const result = resolveDelay('', 'UTC', { peak_hours: ['20:00-23:00'] });
      expect(result).toBe(new Date('2024-01-16T20:00:00.000Z').toISOString());
    });
  });
});
