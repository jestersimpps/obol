const DEFAULT_PEAK_HOUR = 20;

function resolveDelay(input, timezone, timingData) {
  const dt = parseDateTime(input, timezone, timingData);
  if (dt) return dt;

  const legacy = parseLegacy(input);
  if (legacy) return legacy;

  const peakHour = extractPeakHour(timingData);
  const now = localNow(timezone);
  return targetPeak(now, peakHour, 1, timezone);
}

function parseDateTime(input, timezone, timingData) {
  const dtMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dtMatch) {
    const [, y, m, d, h, min] = dtMatch.map(Number);
    return localToUTC(y, m, d, h, min, timezone).toISOString();
  }

  const dateMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch.map(Number);
    const peak = extractPeakHour(timingData);
    return localToUTC(y, m, d, peak, 0, timezone).toISOString();
  }

  return null;
}

function localToUTC(year, month, day, hour, minute, timezone) {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  try {
    for (let i = 0; i < 3; i++) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d);
      const get = (type) => parseInt(parts.find(p => p.type === type).value);
      const diffMin = (hour * 60 + minute) - (get('hour') * 60 + get('minute'));
      const diffDay = day - get('day');
      const totalDiff = diffDay * 1440 + diffMin;
      if (totalDiff === 0) break;
      d.setTime(d.getTime() + totalDiff * 60000);
    }
    return d;
  } catch {
    return d;
  }
}

function parseLegacy(delay) {
  const units = { h: 3600000, d: 86400000, w: 604800000 };
  const match = delay.match(/^(\d+)([hdw])$/);
  if (!match) return null;
  return new Date(Date.now() + parseInt(match[1]) * units[match[2]]).toISOString();
}

function extractPeakHour(timingData) {
  if (!timingData?.peak_hours?.length) return DEFAULT_PEAK_HOUR;
  const first = timingData.peak_hours[0];
  const hourMatch = first.match(/^(\d{1,2})/);
  if (!hourMatch) return DEFAULT_PEAK_HOUR;
  const hour = parseInt(hourMatch[1]);
  return hour >= 0 && hour <= 23 ? hour : DEFAULT_PEAK_HOUR;
}

function localNow(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (type) => parseInt(parts.find(p => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
  } catch {
    const d = new Date();
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

function targetPeak(now, peakHour, daysAhead, timezone) {
  const base = toUTCDate(now, timezone);
  base.setUTCDate(base.getUTCDate() + daysAhead);
  const target = setLocalHour(base, peakHour, timezone);
  return target.toISOString();
}

function toUTCDate(local, timezone) {
  const dateStr = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}T12:00:00`;
  const utc = new Date(dateStr + 'Z');
  const probe = new Date(utc);
  const localAtProbe = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(probe);
  const probeDay = parseInt(localAtProbe.find(p => p.type === 'day').value);
  if (probeDay !== local.day) {
    const offset = probeDay > local.day ? -1 : 1;
    utc.setUTCDate(utc.getUTCDate() + offset);
  }
  return utc;
}

function setLocalHour(utcDate, targetHour, timezone) {
  const d = new Date(utcDate);
  d.setUTCHours(targetHour, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', hour12: false,
    }).formatToParts(d);
    const localHour = parseInt(parts.find(p => p.type === 'hour').value);
    if (localHour === targetHour) return d;
    const diff = targetHour - localHour;
    d.setUTCHours(d.getUTCHours() + diff);
  }
  return d;
}

module.exports = { resolveDelay, extractPeakHour };
