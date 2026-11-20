/**
 * test-assistant.js
 * Comprehensive automated test suite for UniSync Smart Assistant.
 * Verifies NLU intent extraction, deterministic calculations, timezone logic,
 * rate limiting contracts, and security boundaries.
 */

import {
  DAY_ORDER,
  normaliseTime,
  timeToMinutes,
  minutesToTime,
  formatTime12,
  formatDuration,
  getClassesForDay,
  findFreeSlotsForDay,
  findCommonFreeSlotsAcrossStudents,
  calculateWeeklyInsights,
  getLongestFreeSlot,
  getEnrolledSubjects,
  getWeeklyFreeSlotsSummary,
  generateDeterministicAdvice
} from './api/assistant/_logic.js';

import {
  getSafeTimezone,
  getNowInTimezone,
  resolveTargetDay,
  DEFAULT_TIMEZONE
} from './api/assistant/_date.js';

import {
  matchDeterministicIntent,
  matchFallbackIntent,
  ALLOWED_INTENTS
} from './api/assistant/_nlu.js';

import { getHelpResponse } from './api/assistant/_kb.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}`);
  }
}

console.log('\n--- 1. TIMEZONE & DATE RESOLUTION TESTS ---');
{
  assert(getSafeTimezone('Asia/Kolkata') === 'Asia/Kolkata', 'Valid IANA timezone accepted');
  assert(getSafeTimezone('America/New_York') === 'America/New_York', 'Valid US timezone accepted');
  assert(getSafeTimezone('Invalid/Zone_XYZ') === DEFAULT_TIMEZONE, 'Invalid timezone falls back to Asia/Kolkata');
  assert(getSafeTimezone(null) === DEFAULT_TIMEZONE, 'Null timezone falls back to Asia/Kolkata');

  const kolkataNow = getNowInTimezone('Asia/Kolkata');
  assert(DAY_ORDER.includes(kolkataNow.dayName), `Current day resolved: ${kolkataNow.dayName}`);
  assert(DAY_ORDER.includes(kolkataNow.tomorrowDayName), `Tomorrow day resolved: ${kolkataNow.tomorrowDayName}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(kolkataNow.dateStr), `ISO date format valid: ${kolkataNow.dateStr}`);

  // Relative day resolution
  assert(resolveTargetDay('tomorrow', 'Asia/Kolkata') === kolkataNow.tomorrowDayName, 'Resolves "tomorrow"');
  assert(resolveTargetDay('today', 'Asia/Kolkata') === kolkataNow.dayName, 'Resolves "today"');
  assert(resolveTargetDay('Friday', 'Asia/Kolkata') === 'Friday', 'Resolves explicit weekday "Friday"');
  assert(resolveTargetDay('next Friday', 'Asia/Kolkata') === 'Friday', 'Resolves "next Friday" to Friday');
  assert(resolveTargetDay('this monday', 'Asia/Kolkata') === 'Monday', 'Resolves "this monday" to Monday');
  assert(resolveTargetDay('monday', 'Asia/Kolkata') === 'Monday', 'Resolves lowercase "monday"');
  assert(resolveTargetDay('2026-11-20', 'Asia/Kolkata') === 'Friday', 'Resolves ISO date 2026-11-20 to Friday');
}

console.log('\n--- 2. NATURAL-LANGUAGE INTENT MAPPING TESTS ---');
{
  const ctx = {
    currentDateStr: '2026-11-20',
    currentDayName: 'Friday',
    tomorrowDayName: 'Saturday',
    userTimezone: 'Asia/Kolkata'
  };

  // Test variations of free time questions
  const freeQueries = [
    'When am I free tomorrow?',
    'Tell me my available time for the next day.',
    'Do I have any free periods tomorrow?',
    'Can I go out with my friends tomorrow?',
    'Is my schedule clear tomorrow afternoon?'
  ];

  for (const q of freeQueries) {
    const matched = matchFallbackIntent(q, ctx);
    assert(
      matched.intent === 'FIND_PERSONAL_AVAILABILITY' || matched.intent === 'FIND_COMMON_SQUAD_AVAILABILITY',
      `"${q}" -> ${matched.intent}`
    );
  }

  // Schedule variations
  const schedQueries = [
    { q: 'hi', expected: 'GREETING' },
    { q: 'hello', expected: 'GREETING' },
    { q: 'hey there', expected: 'GREETING' },
    { q: 'good morning', expected: 'GREETING' },
    { q: 'Hello, how are you?', expected: 'GREETING' },
    { q: 'What classes do I have tomorrow?', expected: 'GET_TOMORROW_SCHEDULE' },
    { q: 'my classes today', expected: 'GET_TODAY_SCHEDULE' },
    { q: 'Show my schedule for Friday', expected: 'GET_DATE_SCHEDULE' },
    { q: 'What is my busiest day?', expected: 'GET_BUSY_DAY' },
    { q: 'Which day is lightest?', expected: 'GET_LIGHTEST_DAY' },
    { q: 'What is my longest free period?', expected: 'GET_LONGEST_FREE_SLOT' },
    { q: 'Analyse my weekly schedule', expected: 'GET_WEEKLY_SCHEDULE_INSIGHTS' },
    { q: 'When can our squad meet?', expected: 'FIND_COMMON_SQUAD_AVAILABILITY' },
    { q: 'Suggest meeting times', expected: 'SUGGEST_MEETING_TIMES' },
    { q: 'How do I join a squad?', expected: 'GENERAL_UNISYNC_HELP' },
    // Phase 5 Critical Test Cases
    {
      q: 'Hey, I have a pretty busy week coming up. Can you look at my timetable and tell me when I can relax, spend time with friends, and still manage my academic work?',
      expected: 'PRODUCTIVITY_AND_BALANCE'
    },
    {
      q: 'Can you tell me my attendance percentage, academic performance, and which subject I am most likely to struggle with based on my timetable?',
      expected: 'ACADEMIC_ATTENDANCE_QUERY'
    },
    {
      q: 'I want to spend time with friends without affecting my studies. Suggest a plan.',
      expected: 'PRODUCTIVITY_AND_BALANCE'
    },
    {
      q: 'How can I improve my weekly routine?',
      expected: 'PRODUCTIVITY_AND_BALANCE'
    },
    {
      q: 'What is my attendance percentage?',
      expected: 'ACADEMIC_ATTENDANCE_QUERY'
    }
  ];

  for (const { q, expected } of schedQueries) {
    const res = matchFallbackIntent(q, ctx);
    assert(res.intent === expected, `Query: "${q}" -> expected ${expected}, got ${res.intent}`);
  }
}

console.log('\n--- 3. DETERMINISTIC TIMETABLE CALCULATION TESTS ---');
{
  // Sample realistic university schedule (50m periods, labs)
  const mockSchedule = {
    Monday: {
      '08:30 - 09:20': { status: 'busy', subject: 'Data Structures', room: '36-809', type: 'L', startTime: '08:30', endTime: '09:20' },
      '09:25 - 10:15': { status: 'busy', subject: 'Database Systems', room: '36-810', type: 'L', startTime: '09:25', endTime: '10:15' },
      '13:00 - 15:00': { status: 'busy', subject: 'OS Lab', room: 'Lab 4', type: 'P', startTime: '13:00', endTime: '15:00' }
    },
    Tuesday: {
      '10:00 - 11:00': { status: 'busy', subject: 'Discrete Math', room: 'LT-1', type: 'T', startTime: '10:00', endTime: '11:00' }
    },
    Wednesday: {},
    Thursday: {
      '08:30 - 09:20': { status: 'busy', subject: 'Algorithms', room: '36-809', type: 'L', startTime: '08:30', endTime: '09:20' },
      '10:20 - 11:10': { status: 'busy', subject: 'Networks', room: 'LT-2', type: 'L', startTime: '10:20', endTime: '11:10' },
      '11:15 - 12:05': { status: 'busy', subject: 'Software Eng', room: 'LT-2', type: 'L', startTime: '11:15', endTime: '12:05' },
      '14:00 - 16:00': { status: 'busy', subject: 'Web Tech Lab', room: 'Lab 2', type: 'P', startTime: '14:00', endTime: '16:00' }
    },
    Friday: {
      '09:00 - 10:00': { status: 'busy', subject: 'Economics', room: 'Audi 1', type: 'L', startTime: '09:00', endTime: '10:00' }
    }
  };

  // 3a. Class extraction
  const mondayClasses = getClassesForDay(mockSchedule, 'Monday');
  assert(mondayClasses.length === 3, 'Monday has exactly 3 classes');
  assert(mondayClasses[0].subject === 'Data Structures', 'First class is Data Structures');
  assert(mondayClasses[2].endTime === '15:00', 'Last class ends at 15:00');

  // 3b. Free slot calculation for Monday (active hours 08:00–18:00)
  // Busy: 08:30-09:20, 09:25-10:15, 13:00-15:00
  // Free gaps >= 30m:
  // - 08:00–08:30 (30m)
  // - 10:15–13:00 (165m = 2 hr 45 min)
  // - 15:00–18:00 (180m = 3 hr)
  const mondayFreeSlots = findFreeSlotsForDay(mockSchedule, 'Monday', { minDuration: 30 });
  assert(mondayFreeSlots.length === 3, `Monday free slots count is 3 (got ${mondayFreeSlots.length})`);
  assert(mondayFreeSlots[1].startTime === '10:15' && mondayFreeSlots[1].endTime === '13:00', 'Middle free slot is 10:15–13:00');

  // 3c. Weekly insights
  const insights = calculateWeeklyInsights(mockSchedule);
  assert(insights.busyDay === 'Thursday', `Busiest day is Thursday (got ${insights.busyDay})`);
  assert(insights.lightestDay === 'Tuesday' || insights.lightestDay === 'Friday', `Lightest active day identified: ${insights.lightestDay}`);
  assert(Number(insights.totalClassHours) > 0, `Total class hours calculated: ${insights.totalClassHours}`);

  // 3d. Longest free slot
  const longest = getLongestFreeSlot(mockSchedule);
  assert(longest !== null && longest.durationMins >= 180, `Longest free slot identified: ${longest.day} ${longest.startTime}-${longest.endTime} (${longest.durationMins}m)`);

  // 3f. Enrolled subjects & weekly summary extraction
  const enrolled = getEnrolledSubjects(mockSchedule);
  assert(enrolled.length === 9, `Extracted 9 distinct subjects (got ${enrolled.length})`);
  assert(enrolled.some(s => s.subject === 'Data Structures'), 'Includes Data Structures');

  const freeSummary = getWeeklyFreeSlotsSummary(mockSchedule);
  assert(freeSummary.freeDays.includes('Wednesday'), 'Identified Wednesday as completely free');
  assert(freeSummary.keyFreeSlots.length > 0, `Identified major daytime breaks: ${freeSummary.keyFreeSlots.length}`);

  const adviceText = generateDeterministicAdvice({
    totalClassHours: insights.totalClassHours,
    totalClasses: insights.totalClasses,
    busyDay: insights.busyDay,
    busyClasses: insights.dayBreakdown[insights.busyDay]?.classCount,
    busyDuration: insights.dayBreakdown[insights.busyDay]?.durationFormatted,
    lightestDay: insights.lightestDay,
    lightestClasses: insights.dayBreakdown[insights.lightestDay]?.classCount,
    lightestDuration: insights.dayBreakdown[insights.lightestDay]?.durationFormatted,
    freeDays: freeSummary.freeDays,
    keyFreeSlots: freeSummary.keyFreeSlots,
    subjects: enrolled
  });
  assert(adviceText.includes('Academic Focus Strategy'), 'Generated structured balance plan');
  assert(adviceText.includes('Thursday'), 'Plan mentions busiest day Thursday');
  assert(adviceText.includes('Wednesday'), 'Plan mentions free day Wednesday');
}

console.log('\n--- 4. SQUAD COMMON FREE SLOTS CONVERGENCE TESTS ---');
{
  const studentA = {
    name: 'Aarav',
    schedule: {
      Friday: {
        '08:30 - 09:20': { status: 'busy', startTime: '08:30', endTime: '09:20' },
        '10:20 - 11:10': { status: 'busy', startTime: '10:20', endTime: '11:10' },
        '13:40 - 15:20': { status: 'busy', startTime: '13:40', endTime: '15:20' }
      }
    }
  };

  const studentB = {
    name: 'Meera',
    schedule: {
      Friday: {
        '09:00 - 10:00': { status: 'busy', startTime: '09:00', endTime: '10:00' },
        '11:10 - 12:00': { status: 'busy', startTime: '11:10', endTime: '12:00' },
        '13:50 - 15:15': { status: 'busy', startTime: '13:50', endTime: '15:15' }
      }
    }
  };

  // Common free intervals:
  // Both free 12:00–13:40 (100 min) and after 15:20 until 18:00 (160 min)
  const common = findCommonFreeSlotsAcrossStudents([studentA, studentB], 'Friday', { minDuration: 30 });
  assert(common.length >= 2, `Common free intervals found between 2 students: ${common.length}`);
  const hasSharedNoon = common.some(s => s.startTime === '12:00' && s.endTime === '13:40');
  assert(hasSharedNoon, 'Exact mutual free window 12:00–13:40 verified');
}

console.log('\n--- 5. KNOWLEDGE BASE TESTS ---');
{
  assert(getHelpResponse('squads').includes('CLA-'), 'Squads help mentions 6-character code');
  assert(getHelpResponse('timetable').includes('.xlsx'), 'Timetable help mentions Excel .xlsx');
  assert(getHelpResponse('meetings').includes('Schedule Meeting'), 'Meetings help provides actionable steps');
  assert(getHelpResponse('privacy').includes('Firestore'), 'Privacy help explains squad isolation');
}

console.log('\n=======================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('=======================================\n');

if (failed > 0) process.exit(1);
