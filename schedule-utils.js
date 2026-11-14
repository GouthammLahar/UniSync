/**
 * schedule-utils.js
 * Universal timetable and interval math utilities for UniSync.
 * Works with ANY university timetable regardless of period durations (45m, 50m, 60m, 2h labs),
 * period start times (08:20, 08:30, 09:00, etc.), or 12h/24h formats.
 */

export const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const TYPE_LABEL_MAP = {
  L: 'Lecture',
  T: 'Tutorial',
  P: 'Practical',
  LAB: 'Practical',
  W: 'Workshop'
};

/**
 * Normalise any time string (12-hour AM/PM, 24-hour, single digit hour, dots)
 * into strict 24-hour "HH:MM" format.
 * Examples:
 *   "8:30"      -> "08:30"
 *   "8:30 AM"   -> "08:30"
 *   "08:30 am"  -> "08:30"
 *   "1:40 PM"   -> "13:40"
 *   "01:40 pm"  -> "13:40"
 *   "12:00 PM"  -> "12:00"
 *   "12:30 AM"  -> "00:30"
 *   "8.20"      -> "08:20"
 *   "14:30"     -> "14:30"
 */
export function normaliseTime(t) {
  if (!t) return '';
  let s = String(t).trim();

  // Replace dot with colon if used as time separator e.g. "8.30" -> "8:30"
  s = s.replace(/(\d{1,2})\.(\d{2})/, '$1:$2');

  // Match "H:MM", "HH:MM", optional seconds, optional AM/PM
  const match = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const ampm = (match[3] || '').toUpperCase();

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  // Compact format like "0830"
  const compact = s.match(/^(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}:${compact[2]}`;
  }

  return s;
}

/**
 * Converts a time string to minutes from midnight (0 - 1439).
 */
export function timeToMinutes(t) {
  if (!t) return 0;
  const norm = normaliseTime(t);
  const parts = norm.split(':').map(Number);
  const h = isNaN(parts[0]) ? 0 : parts[0];
  const m = isNaN(parts[1]) ? 0 : parts[1];
  return h * 60 + m;
}

/**
 * Converts minutes from midnight into 24-hour "HH:MM" format.
 */
export function minutesToTime(mins) {
  const safeMins = Math.max(0, Math.min(1439, Math.round(mins)));
  const h = Math.floor(safeMins / 60);
  const m = safeMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Converts "HH:MM" (or any valid time string) to friendly 12-hour string (e.g. "8:30 AM", "1:40 PM").
 */
export function formatTime12(t24) {
  if (!t24) return '';
  const norm = normaliseTime(t24);
  const [hStr, mStr] = norm.split(':');
  let hour = parseInt(hStr, 10);
  if (isNaN(hour)) return t24;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${mStr || '00'} ${ampm}`;
}

/**
 * Formats duration in minutes into clean readable text: "50 mins", "1 hr", "1 hr 30 mins".
 */
export function formatDuration(durationMinutes) {
  if (!durationMinutes || durationMinutes <= 0) return '0 mins';
  if (durationMinutes < 60) return `${durationMinutes} mins`;
  const h = Math.floor(durationMinutes / 60);
  const m = durationMinutes % 60;
  const hStr = h === 1 ? '1 hr' : `${h} hrs`;
  return m > 0 ? `${hStr} ${m} mins` : hStr;
}

/**
 * Extracts and normalizes all busy classes for a given student on a given day.
 * Returns an array of class objects sorted chronologically by start time.
 */
export function getStudentClassesForDay(schedule, day) {
  if (!schedule || !schedule[day]) return [];
  const entries = Object.entries(schedule[day]);
  const classes = [];

  for (const [key, data] of entries) {
    if (!data || data.status !== 'busy') continue;

    let startTime = data.startTime;
    let endTime = data.endTime;

    // Fallback: extract start and end from slot key e.g. "08:30 - 09:20" or "8:30-9:20"
    if (!startTime || !endTime) {
      const match = key.match(/(\d{1,2}[:.]\d{2}(?:\s*[AaPp][Mm])?)\s*-\s*(\d{1,2}[:.]\d{2}(?:\s*[AaPp][Mm])?)/);
      if (match) {
        startTime = match[1];
        endTime = match[2];
      }
    }

    if (!startTime || !endTime) continue;

    startTime = normaliseTime(startTime);
    endTime = normaliseTime(endTime);

    const startMins = timeToMinutes(startTime);
    const endMins = timeToMinutes(endTime);

    // Skip corrupted or zero-length entries
    if (endMins <= startMins) continue;

    classes.push({
      ...data,
      day,
      startTime,
      endTime,
      startMins,
      endMins
    });
  }

  return classes.sort((a, b) => a.startMins - b.startMins);
}

/**
 * Checks if a student is busy at a point in time or during an interval [queryStartMins, queryEndMins).
 * If queryEndMins is omitted or equals queryStartMins, it checks that specific instant.
 */
export function checkStudentBusy(schedule, day, queryStartMins, queryEndMins = null) {
  const classes = getStudentClassesForDay(schedule, day);
  if (classes.length === 0) {
    return { isBusy: false, class: null };
  }

  const qStart = queryStartMins;
  const qEnd = (queryEndMins !== null && queryEndMins > queryStartMins)
    ? queryEndMins
    : queryStartMins + 1;

  for (const cls of classes) {
    // Two intervals [A, B) and [C, D) overlap if max(A, C) < min(B, D)
    if (Math.max(qStart, cls.startMins) < Math.min(qEnd, cls.endMins)) {
      return {
        isBusy: true,
        class: cls
      };
    }
  }

  return { isBusy: false, class: null };
}

/**
 * Finds the exact continuous free intervals when ALL selected students are simultaneously free.
 * Works seamlessly across friends with different class lengths and start times.
 *
 * @param {Array} students Array of student objects with { name, schedule }
 * @param {String} day e.g. "Monday"
 * @param {Object} options
 *   - dayStartMins: start of university active hours (default 08:00 = 480)
 *   - dayEndMins: end of university active hours (default 18:00 = 1080)
 *   - minDuration: minimum duration of free slot in minutes (default 30)
 * @returns {Array} Array of free slots: [{ startTime, endTime, startMins, endMins, durationMins }, ...]
 */
export function findCommonFreeSlots(students, day, options = {}) {
  if (!students || students.length === 0) return [];

  const dayStartMins = options.dayStartMins ?? (8 * 60);    // 08:00
  const dayEndMins   = options.dayEndMins   ?? (18 * 60);   // 18:00
  const minDuration  = options.minDuration  ?? 30;          // 30 mins

  // 1. Collect all busy intervals across all selected students
  const busyIntervals = [];

  for (const student of students) {
    const studentClasses = getStudentClassesForDay(student.schedule, day);
    for (const cls of studentClasses) {
      const bStart = Math.max(dayStartMins, cls.startMins);
      const bEnd = Math.min(dayEndMins, cls.endMins);
      if (bEnd > bStart) {
        busyIntervals.push([bStart, bEnd]);
      }
    }
  }

  // 2. Merge overlapping or contiguous busy intervals
  busyIntervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const mergedBusy = [];
  for (const [start, end] of busyIntervals) {
    if (mergedBusy.length === 0) {
      mergedBusy.push([start, end]);
    } else {
      const prev = mergedBusy[mergedBusy.length - 1];
      if (start <= prev[1]) {
        prev[1] = Math.max(prev[1], end);
      } else {
        mergedBusy.push([start, end]);
      }
    }
  }

  // 3. Find the gaps between dayStartMins and dayEndMins
  const freeIntervals = [];
  let currentPointer = dayStartMins;

  for (const [bStart, bEnd] of mergedBusy) {
    if (bStart > currentPointer) {
      const duration = bStart - currentPointer;
      if (duration >= minDuration) {
        freeIntervals.push({
          startMins: currentPointer,
          endMins: bStart,
          startTime: minutesToTime(currentPointer),
          endTime: minutesToTime(bStart),
          durationMins: duration
        });
      }
    }
    currentPointer = Math.max(currentPointer, bEnd);
  }

  // Final gap after last class until dayEndMins
  if (currentPointer < dayEndMins) {
    const duration = dayEndMins - currentPointer;
    if (duration >= minDuration) {
      freeIntervals.push({
        startMins: currentPointer,
        endMins: dayEndMins,
        startTime: minutesToTime(currentPointer),
        endTime: minutesToTime(dayEndMins),
        durationMins: duration
      });
    }
  }

  return freeIntervals;
}
