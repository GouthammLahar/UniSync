/**
 * api/assistant/_logic.js
 * Server-side scheduling & timetable calculations for the UniSync Assistant.
 * Uses exact interval arithmetic to ensure factual accuracy without LLM hallucinations.
 */

export const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const TYPE_LABEL_MAP = {
  L: 'Lecture',
  T: 'Tutorial',
  P: 'Practical',
  LAB: 'Practical',
  W: 'Workshop'
};

export function normaliseTime(t) {
  if (!t) return '';
  let s = String(t).trim();
  s = s.replace(/(\d{1,2})\.(\d{2})/, '$1:$2');
  const match = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const ampm = (match[3] || '').toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
  const compact = s.match(/^(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}:${compact[2]}`;
  return s;
}

export function timeToMinutes(t) {
  if (!t) return 0;
  const norm = normaliseTime(t);
  const parts = norm.split(':').map(Number);
  const h = isNaN(parts[0]) ? 0 : parts[0];
  const m = isNaN(parts[1]) ? 0 : parts[1];
  return h * 60 + m;
}

export function minutesToTime(mins) {
  const safeMins = Math.max(0, Math.min(1439, Math.round(mins)));
  const h = Math.floor(safeMins / 60);
  const m = safeMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

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

export function formatDuration(durationMinutes) {
  if (!durationMinutes || durationMinutes <= 0) return '0 mins';
  if (durationMinutes < 60) return `${durationMinutes} mins`;
  const h = Math.floor(durationMinutes / 60);
  const m = durationMinutes % 60;
  const hStr = h === 1 ? '1 hr' : `${h} hrs`;
  return m > 0 ? `${hStr} ${m} mins` : hStr;
}

export function getClassesForDay(schedule, day) {
  if (!schedule || !schedule[day]) return [];
  const entries = Object.entries(schedule[day]);
  const classes = [];

  for (const [key, data] of entries) {
    if (!data || data.status !== 'busy') continue;
    let startTime = data.startTime;
    let endTime = data.endTime;
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

export function findFreeSlotsForDay(schedule, day, options = {}) {
  const dayStartMins = options.dayStartMins ?? (8 * 60);   // 08:00
  const dayEndMins   = options.dayEndMins   ?? (18 * 60);  // 18:00
  const minDuration  = options.minDuration  ?? 30;         // 30 mins

  const classes = getClassesForDay(schedule, day);
  const busyIntervals = [];

  for (const cls of classes) {
    const bStart = Math.max(dayStartMins, cls.startMins);
    const bEnd = Math.min(dayEndMins, cls.endMins);
    if (bEnd > bStart) busyIntervals.push([bStart, bEnd]);
  }

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

export function findCommonFreeSlotsAcrossStudents(students, day, options = {}) {
  const dayStartMins = options.dayStartMins ?? (8 * 60);   // 08:00
  const dayEndMins   = options.dayEndMins   ?? (18 * 60);  // 18:00
  const minDuration  = options.minDuration  ?? 30;         // 30 mins

  const busyIntervals = [];
  for (const student of students) {
    const classes = getClassesForDay(student.schedule, day);
    for (const cls of classes) {
      const bStart = Math.max(dayStartMins, cls.startMins);
      const bEnd = Math.min(dayEndMins, cls.endMins);
      if (bEnd > bStart) busyIntervals.push([bStart, bEnd]);
    }
  }

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

export function calculateWeeklyInsights(schedule) {
  if (!schedule) {
    return {
      totalClassHours: 0,
      totalClasses: 0,
      busyDay: null,
      lightestDay: null,
      dayBreakdown: {}
    };
  }

  let totalMins = 0;
  let totalClasses = 0;
  const breakdown = {};
  let maxDay = null;
  let maxMins = -1;
  let minDay = null;
  let minMins = 999999;

  for (const day of DAY_ORDER) {
    const classes = getClassesForDay(schedule, day);
    let dayMins = 0;
    for (const c of classes) {
      dayMins += (c.endMins - c.startMins);
    }
    totalMins += dayMins;
    totalClasses += classes.length;
    breakdown[day] = {
      classCount: classes.length,
      durationMins: dayMins,
      durationFormatted: formatDuration(dayMins)
    };

    if (classes.length > 0 && dayMins > maxMins) {
      maxMins = dayMins;
      maxDay = day;
    }
    if (classes.length > 0 && dayMins < minMins) {
      minMins = dayMins;
      minDay = day;
    }
  }

  return {
    totalClassHours: (totalMins / 60).toFixed(1),
    totalClasses,
    busyDay: maxDay,
    busyDayMins: maxMins > 0 ? maxMins : 0,
    lightestDay: minDay,
    lightestDayMins: minMins < 999999 ? minMins : 0,
    dayBreakdown: breakdown
  };
}

export function getLongestFreeSlot(schedule) {
  let longest = null;
  for (const day of DAY_ORDER) {
    const slots = findFreeSlotsForDay(schedule, day);
    for (const slot of slots) {
      if (!longest || slot.durationMins > longest.durationMins) {
        longest = { ...slot, day };
      }
    }
  }
  return longest;
}
