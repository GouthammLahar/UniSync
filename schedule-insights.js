/**
 * schedule-insights.js — UniSync Personal Schedule Insights
 *
 * Computes weekly analytics for the authenticated user's timetable.
 * Uses existing schedule-utils helpers (getStudentClassesForDay, findCommonFreeSlots).
 * No Firestore reads — works on the in-memory schedule object already loaded in app.js.
 *
 * College operating window: 08:00 – 18:00 (480 – 1080 mins), matching the Free-Slots
 * default defined in schedule-utils.js / free-time-window selector in index.html.
 */

import {
  getStudentClassesForDay,
  findCommonFreeSlots,
  formatTime12,
  formatDuration,
  timeToMinutes,
  DAY_ORDER
} from './schedule-utils.js?v=10';

// College active hours (minutes from midnight) — matches free-slot selector default
export const COLLEGE_START = 8 * 60;  // 08:00
export const COLLEGE_END   = 18 * 60; // 18:00

// Weekdays we consider (Sunday excluded from analytics, can appear in schedule)
const ANALYSIS_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Merge overlapping busy intervals (sorted by start). Returns merged array of [start, end].
 * @param {Array<[number,number]>} intervals
 * @returns {Array<[number,number]>}
 */
function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur  = sorted[i];
    if (cur[0] < prev[1]) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Calculates occupied class minutes for a single day, deduplicated/merged.
 * Clamped to college hours.
 * @param {Object} schedule  - full schedule map
 * @param {string} day
 * @returns {number} occupied minutes (within college hours, overlaps removed)
 */
function getOccupiedMinsForDay(schedule, day) {
  const classes = getStudentClassesForDay(schedule, day);
  const rawIntervals = classes.map(c => [
    Math.max(COLLEGE_START, c.startMins),
    Math.min(COLLEGE_END,   c.endMins)
  ]).filter(([s, e]) => e > s);

  const merged = mergeIntervals(rawIntervals);
  return merged.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/**
 * Finds the longest continuous free slot for a single day within college hours.
 * @param {Object} schedule
 * @param {string} day
 * @returns {{ durationMins: number, startTime: string, endTime: string } | null}
 */
function getLongestFreeSlotForDay(schedule, day) {
  const freeSlots = findCommonFreeSlots(
    [{ schedule }],
    day,
    { dayStartMins: COLLEGE_START, dayEndMins: COLLEGE_END, minDuration: 1 }
  );
  if (!freeSlots.length) return null;
  return freeSlots.reduce((best, s) => s.durationMins > best.durationMins ? s : best, freeSlots[0]);
}

/**
 * Main insights calculation. Pure function — no Firestore calls.
 *
 * @param {Object|null} schedule  - currentUserSchedule (may be null/empty)
 * @param {Array}       meetings  - array of meeting objects from Firestore listener
 * @param {string}      uid       - current user UID (to filter upcoming meetings)
 * @returns {Object} insights
 */
export function computeInsights(schedule, meetings = [], uid = '') {
  // --- Empty timetable guard ---
  if (!schedule || Object.keys(schedule).length === 0) {
    return {
      hasData: false,
      totalClassesWeek: 0,
      totalOccupiedHrs: 0,
      totalFreeHrs: 0,
      busiestDay: null,
      lightestDay: null,
      longestFreeSlot: null,
      upcomingMeetings: [],
      perDayClasses: {},
      perDayOccupiedMins: {}
    };
  }

  const perDayClasses      = {};
  const perDayOccupiedMins = {};
  let totalClassesWeek = 0;
  let totalOccupiedMins = 0;

  // --- Per-day stats ---
  for (const day of ANALYSIS_DAYS) {
    const classes = getStudentClassesForDay(schedule, day);
    // Count only valid busy classes
    const count = classes.length;
    const occupied = getOccupiedMinsForDay(schedule, day);

    perDayClasses[day]      = count;
    perDayOccupiedMins[day] = occupied;
    totalClassesWeek += count;
    totalOccupiedMins += occupied;
  }

  // --- Active days (days with at least 1 class) ---
  const activeDays = ANALYSIS_DAYS.filter(d => perDayClasses[d] > 0);

  // --- Busiest / Lightest weekday ---
  let busiestDay  = null;
  let lightestDay = null;
  let maxMins = -1;
  let minMins = Infinity;

  for (const day of activeDays) {
    const m = perDayOccupiedMins[day];
    if (m > maxMins) { maxMins = m; busiestDay  = day; }
    if (m < minMins) { minMins = m; lightestDay = day; }
  }

  // --- Total free hours within college hours across the week ---
  const totalCollegeWindowPerDay = COLLEGE_END - COLLEGE_START; // 600 mins per day
  const activeDayCount = activeDays.length;
  // We calculate free hours only on days that have classes
  let totalFreeMins = 0;
  for (const day of activeDays) {
    totalFreeMins += Math.max(0, totalCollegeWindowPerDay - perDayOccupiedMins[day]);
  }

  // --- Longest free slot across the week ---
  let longestFreeSlot = null;
  let longestDurationMins = 0;
  for (const day of ANALYSIS_DAYS) {
    const slot = getLongestFreeSlotForDay(schedule, day);
    if (slot && slot.durationMins > longestDurationMins) {
      longestDurationMins = slot.durationMins;
      longestFreeSlot = { ...slot, day };
    }
  }

  // --- Upcoming meetings (next 7 days) ---
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const upcomingMeetings = meetings
    .filter(m => {
      if (!m.date || !m.startTime) return false;
      if (m.status === 'cancelled') return false;
      if (!m.participants?.includes(uid)) return false;
      const meetingDate = new Date(`${m.date}T${m.startTime}:00`);
      return meetingDate >= now && meetingDate <= in7Days;
    })
    .sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`))
    .slice(0, 3);

  return {
    hasData: true,
    totalClassesWeek,
    totalOccupiedHrs: parseFloat((totalOccupiedMins / 60).toFixed(1)),
    totalFreeHrs:     parseFloat((totalFreeMins / 60).toFixed(1)),
    busiestDay,
    lightestDay,
    longestFreeSlot,
    upcomingMeetings,
    perDayClasses,
    perDayOccupiedMins,
    activeDayCount
  };
}

/**
 * Renders the Personal Schedule Insights section inside #schedule-insights-section.
 * Called from renderDashboard() in app.js whenever the schedule/meetings update.
 *
 * @param {Object} insights  - result of computeInsights()
 */
export function renderInsights(insights) {
  const container = document.getElementById('schedule-insights-section');
  if (!container) return;

  if (!insights.hasData) {
    container.innerHTML = `
      <div class="insights-empty-state">
        <span class="insights-empty-icon">📊</span>
        <p class="insights-empty-title">No timetable data yet</p>
        <p class="insights-empty-sub">Import or add your classes to see your weekly schedule insights.</p>
      </div>`;
    return;
  }

  const { totalClassesWeek, totalOccupiedHrs, totalFreeHrs, busiestDay, lightestDay,
          longestFreeSlot, upcomingMeetings, perDayOccupiedMins } = insights;

  // --- Bar Chart HTML ---
  const chartDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullDays  = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const maxMins   = Math.max(...fullDays.map(d => perDayOccupiedMins[d] || 0), 1);

  const barsHtml = fullDays.map((day, i) => {
    const mins    = perDayOccupiedMins[day] || 0;
    const pct     = Math.round((mins / maxMins) * 100);
    const hrs     = (mins / 60).toFixed(1);
    const isBusy  = day === busiestDay;
    const isLight = day === lightestDay && mins > 0;
    const barClass = isBusy ? 'insights-bar busiest' : isLight ? 'insights-bar lightest' : 'insights-bar';
    return `
      <div class="insights-bar-col" title="${day}: ${hrs} hrs">
        <div class="insights-bar-track">
          <div class="${barClass}" style="height:${pct}%;" aria-valuenow="${pct}" role="progressbar"></div>
        </div>
        <div class="insights-bar-label">${chartDays[i]}</div>
        <div class="insights-bar-val">${mins > 0 ? hrs + 'h' : '—'}</div>
      </div>`;
  }).join('');

  // --- Upcoming Meetings HTML ---
  let meetingsHtml = '';
  if (upcomingMeetings.length === 0) {
    meetingsHtml = `<p class="insights-upcoming-empty">No meetings in the next 7 days</p>`;
  } else {
    meetingsHtml = upcomingMeetings.map(m => {
      const dateStr = m.date
        ? new Date(m.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
        : '—';
      const timeStr = m.startTime ? formatTime12(m.startTime) : '';
      const statusIcon = m.status === 'confirmed' ? '✅' :
                         m.status === 'voting_open' ? '🗳️' : '⏳';
      return `
        <div class="insights-meeting-pill">
          <span class="insights-meeting-icon">${statusIcon}</span>
          <div class="insights-meeting-info">
            <span class="insights-meeting-title">${m.title || 'Meeting'}</span>
            <span class="insights-meeting-time">${dateStr}${timeStr ? ' · ' + timeStr : ''}</span>
          </div>
        </div>`;
    }).join('');
  }

  // --- Longest Free Slot ---
  const freeSlotText = longestFreeSlot
    ? `${longestFreeSlot.day}: ${formatTime12(longestFreeSlot.startTime)} – ${formatTime12(longestFreeSlot.endTime)} (${formatDuration(longestFreeSlot.durationMins)})`
    : 'No free slot detected';

  container.innerHTML = `
    <div class="insights-header">
      <h3 class="insights-title">📊 Schedule Insights</h3>
      <span class="insights-subtitle">This week's breakdown</span>
    </div>

    <div class="insights-stats-row">
      <div class="insights-stat-card">
        <span class="insights-stat-label">Classes this week</span>
        <span class="insights-stat-val">${totalClassesWeek}</span>
      </div>
      <div class="insights-stat-card">
        <span class="insights-stat-label">Occupied hours</span>
        <span class="insights-stat-val">${totalOccupiedHrs}h</span>
      </div>
      <div class="insights-stat-card">
        <span class="insights-stat-label">Free hours</span>
        <span class="insights-stat-val" style="color:var(--forest);">${totalFreeHrs}h</span>
      </div>
      <div class="insights-stat-card">
        <span class="insights-stat-label">Busiest day</span>
        <span class="insights-stat-val insights-day-badge busiest-badge">${busiestDay ? busiestDay.slice(0, 3) : '—'}</span>
      </div>
      <div class="insights-stat-card">
        <span class="insights-stat-label">Lightest day</span>
        <span class="insights-stat-val insights-day-badge lightest-badge">${lightestDay ? lightestDay.slice(0, 3) : '—'}</span>
      </div>
    </div>

    <div class="insights-body">
      <div class="insights-chart-wrap">
        <div class="insights-chart-label">Class hours per day (${COLLEGE_START / 60}:00 – ${COLLEGE_END / 60}:00)</div>
        <div class="insights-chart">
          ${barsHtml}
        </div>
        <div class="insights-chart-legend">
          <span class="legend-dot busiest-dot"></span><span>Busiest</span>
          <span class="legend-dot lightest-dot"></span><span>Lightest</span>
        </div>
      </div>

      <div class="insights-side-col">
        <div class="insights-free-slot-box">
          <span class="insights-free-slot-label">⏱ Longest free slot</span>
          <span class="insights-free-slot-val">${freeSlotText}</span>
        </div>
        <div class="insights-upcoming-box">
          <span class="insights-upcoming-label">📅 Upcoming meetings</span>
          <div class="insights-upcoming-list">
            ${meetingsHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}
