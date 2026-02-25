const fs = require('fs');
const path = require('path');

function resolveUserPath(inputPath, userDir) {
  if (!userDir) throw new Error('userDir is required for path resolution');
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(userDir, inputPath);
  const normalizedUser = path.resolve(userDir);

  const isInsideAllowed = (p) =>
    p.startsWith(normalizedUser + path.sep) || p === normalizedUser || p.startsWith('/tmp');

  if (!isInsideAllowed(resolved)) {
    throw new Error(`Path "${inputPath}" is outside your workspace. Use paths relative to your workspace or /tmp.`);
  }

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      if (!isInsideAllowed(realParent)) {
        throw new Error(`Path "${inputPath}" resolves outside your workspace via symlink.`);
      }
      realResolved = path.join(realParent, path.basename(resolved));
    } catch (e) {
      if (e.message.includes('symlink')) throw e;
    }
  }

  if (!isInsideAllowed(realResolved)) {
    throw new Error(`Path "${inputPath}" resolves outside your workspace via symlink. Symlinks to external paths are blocked.`);
  }
  return realResolved;
}

function toUTC(dateStr, timezone) {
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):?(\d{2})?/);
  if (!match) return new Date(dateStr + 'Z').toISOString();
  const [, y, mo, d, h, mi, s] = match;
  const wallAsUTC = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (timezone === 'UTC') return new Date(wallAsUTC).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(wallAsUTC));
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  const hr = +get('hour') === 24 ? 0 : +get('hour');
  const tzWall = Date.UTC(+get('year'), +get('month') - 1, +get('day'), hr, +get('minute'), +get('second'));
  return new Date(wallAsUTC - (tzWall - wallAsUTC)).toISOString();
}

module.exports = { resolveUserPath, toUTC };
