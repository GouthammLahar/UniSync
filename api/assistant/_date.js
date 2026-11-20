/**
 * api/assistant/_date.js
 * Timezone-aware date and weekday resolution.
 * Prevents Vercel server UTC timezone drift.
 * Defaults to Asia/Kolkata if not specified.
 */

import { DAY_ORDER } from './_logic.js';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Validates and normalizes an IANA timezone string.
 */
export function getSafeTimezone(tz) {
  if (!tz || typeof tz !== 'string') return DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Gets the current date, time, and weekday components strictly within the specified timezone.
 */
export function getNowInTimezone(tz) {
  const safeTz = getSafeTimezone(tz);
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const year = map.year;
  const month = map.month;
  const day = map.day;
  const weekday = map.weekday;
  const hour = parseInt(map.hour, 10) || 0;
  const minute = parseInt(map.minute, 10) || 0;

  const dateStr = `${year}-${month}-${day}`;

  // Calculate tomorrow's day name in the student's timezone
  const currentDayIndex = DAY_ORDER.indexOf(weekday);
  const tomorrowDayIndex = currentDayIndex >= 0 ? (currentDayIndex + 1) % 7 : 0;
  const tomorrowDayName = DAY_ORDER[tomorrowDayIndex];

  return {
    timezone: safeTz,
    dateStr,
    dayName: weekday,
    tomorrowDayName,
    hour,
    minute,
    time24: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

/**
 * Resolves a date string or relative expression to a canonical weekday name.
 * e.g. "tomorrow", "Friday", "2026-11-21"
 */
export function resolveTargetDay(requestedDayOrDate, tz) {
  if (!requestedDayOrDate) return null;
  const s = String(requestedDayOrDate).trim();

  // Check if string contains or matches a weekday name (e.g. "Friday", "next Friday", "this Monday", "on Tuesday")
  for (const d of DAY_ORDER) {
    if (new RegExp(`\\b${d}\\b`, 'i').test(s)) {
      return d;
    }
  }

  const nowInfo = getNowInTimezone(tz);

  if (/tomorrow/i.test(s)) return nowInfo.tomorrowDayName;
  if (/today/i.test(s)) return nowInfo.dayName;

  // If ISO date "YYYY-MM-DD"
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    try {
      const d = new Date(`${s}T12:00:00Z`);
      if (!isNaN(d.getTime())) {
        const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: getSafeTimezone(tz),
          weekday: 'long'
        });
        const dayStr = weekdayFormatter.format(d);
        if (DAY_ORDER.includes(dayStr)) return dayStr;
      }
    } catch {
      // Fallback below
    }
  }

  return null;
}
