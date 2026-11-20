/**
 * api/assistant/chat.js — Vercel Serverless: UniSync Smart Assistant Endpoint
 * POST /api/assistant/chat
 *
 * Sequence:
 * 1. Authenticates Firebase ID Token (Bearer token).
 * 2. Validates user input (length, structure, group membership).
 * 3. Timezone-aware date resolution (Asia/Kolkata default).
 * 4. Level 1 Deterministic Intent Matcher.
 * 5. Level 2 Gemini NLU (if needed and quota available; zero schedule data sent to Gemini).
 * 6. Level 3 Deterministic Fallback if Gemini quota/outage occurs.
 * 7. Independent deterministic timetable and squad calculation.
 * 8. Returns verified factual response with remaining quota info.
 */

import { verifyToken, getAdminFirestore } from '../_utils/admin.js';
import {
  DAY_ORDER,
  formatTime12,
  formatDuration,
  getClassesForDay,
  findFreeSlotsForDay,
  findCommonFreeSlotsAcrossStudents,
  calculateWeeklyInsights,
  getLongestFreeSlot
} from './_logic.js';
import { getNowInTimezone, resolveTargetDay, getSafeTimezone } from './_date.js';
import { matchDeterministicIntent, extractIntentWithGemini, matchFallbackIntent } from './_nlu.js';
import { consumeRateLimit, checkRateLimitPrecondition, getUserRemainingAllowance, USER_DAILY_LIMIT } from './_rate-limit.js';
import { getHelpResponse } from './_kb.js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Authentication Check ──────────────────────────────────────────────────
  let decoded;
  let db;
  try {
    decoded = await verifyToken(req);
    db = getAdminFirestore();
  } catch (err) {
    if (err?.message?.includes('private_key') || err?.message?.includes('credential')) {
      return res.status(500).json({ error: 'Server configuration error: Firebase Admin credentials not found in environment.' });
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token.' });
  }

  const uid = decoded.uid;
  const timezone = getSafeTimezone(req.query?.timezone || req.body?.timezone);

  // ── GET: Check Remaining Quota (No consumption) ───────────────────────────
  if (req.method === 'GET' || req.body?.action === 'get_quota') {
    const quota = await getUserRemainingAllowance(db, uid, timezone);
    return res.status(200).json(quota);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── Input Validation ──────────────────────────────────────────────────────
  const { question, groupId: requestedGroupId, conversationContext } = req.body || {};

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Please enter a valid question.' });
  }

  const cleanQuestion = question.trim();
  if (cleanQuestion.length === 0) {
    return res.status(400).json({ error: 'Question cannot be empty.' });
  }
  if (cleanQuestion.length > 500) {
    return res.status(400).json({ error: 'Question is too long (maximum 500 characters).' });
  }

  // Timezone Context
  const timeContext = getNowInTimezone(timezone);

  // Context bundle for NLU
  const nluContext = {
    currentDateStr: timeContext.dateStr,
    currentDayName: timeContext.dayName,
    tomorrowDayName: timeContext.tomorrowDayName,
    userTimezone: timezone,
    recentTurn: (conversationContext && conversationContext.user && conversationContext.assistant)
      ? { user: String(conversationContext.user).slice(0, 150), assistant: String(conversationContext.assistant).slice(0, 150) }
      : null
  };

  // ── Determine Target Group (if needed) ───────────────────────────────────
  let targetGroupId = requestedGroupId ? String(requestedGroupId).trim() : null;
  if (!targetGroupId) {
    try {
      const userSnap = await db.doc(`users/${uid}`).get();
      const groups = userSnap.exists ? (userSnap.data().groups || []) : [];
      if (groups.length > 0) targetGroupId = groups[0];
    } catch (e) {
      console.warn('Could not read user default group:', e.message);
    }
  }

  // ── Step 1: NLU Intent Extraction ─────────────────────────────────────────
  let intentData = null;
  let executionTier = 'deterministic'; // 'deterministic' | 'ai' | 'fallback'

  // Try Level 1: Deterministic Pattern Matcher
  const level1 = matchDeterministicIntent(cleanQuestion, nluContext);
  if (level1) {
    intentData = level1;
    executionTier = 'deterministic';
  } else {
    // Try Level 2: Gemini NLU (consumes rate limit atomically)
    const apiKey = process.env.GEMINI_API_KEY;
    const isGeminiEnabled = Boolean(apiKey && process.env.ENABLE_GEMINI_AI !== 'false');

    if (isGeminiEnabled) {
      try {
        // Pre-check rate limit & cooldown without consuming quota
        await checkRateLimitPrecondition(db, uid, timezone);

        intentData = await extractIntentWithGemini(cleanQuestion, nluContext, apiKey);
        executionTier = 'ai';

        // Atomically consume quota only after successful Gemini response
        await consumeRateLimit(db, uid, timezone);
      } catch (err) {
        if (err.code === 'COOLDOWN_ACTIVE') {
          return res.status(429).json({
            error: err.message,
            code: 'COOLDOWN_ACTIVE',
            waitSecs: err.waitSecs
          });
        }
        if (err.code === 'USER_LIMIT_REACHED' || err.code === 'GLOBAL_LIMIT_REACHED') {
          // If quota reached, try Level 3 fallback for factual queries without crashing or charging
          intentData = matchFallbackIntent(cleanQuestion, nluContext);
          executionTier = 'fallback_quota';
        } else {
          // Gemini failed (outage / network / malformed output) -> Level 3 Fallback without charging
          console.warn('[Assistant] Gemini NLU unavailable, using deterministic fallback:', err.message);
          intentData = matchFallbackIntent(cleanQuestion, nluContext);
          executionTier = 'fallback';
        }
      }
    } else {
      // Gemini not configured or disabled -> Level 3 Fallback
      if (!apiKey) {
        console.warn('[Assistant] Notice: GEMINI_API_KEY is not configured. Running deterministic NLU.');
      }
      intentData = matchFallbackIntent(cleanQuestion, nluContext);
      executionTier = 'deterministic';
    }
  }

  if (!intentData) {
    intentData = { intent: 'UNKNOWN_INTENT', parameters: {} };
  }

  // ── Step 2: Parameter Validation & Day Resolution ─────────────────────────
  const intent = intentData.intent;
  const rawParams = intentData.parameters || {};

  let targetDay = null;
  if (intent === 'GET_TODAY_SCHEDULE') {
    targetDay = timeContext.dayName;
  } else if (intent === 'GET_TOMORROW_SCHEDULE') {
    targetDay = timeContext.tomorrowDayName;
  } else if (rawParams.day) {
    targetDay = resolveTargetDay(rawParams.day, timezone) || rawParams.day;
  } else if (rawParams.date) {
    targetDay = resolveTargetDay(rawParams.date, timezone);
  }

  if (!targetDay && ['GET_DATE_SCHEDULE', 'FIND_PERSONAL_AVAILABILITY'].includes(intent)) {
    targetDay = timeContext.dayName;
  }

  // ── Step 3: Execute Business Logic with Authorised Data ───────────────────
  let answer = '';
  let suggestedPrompts = [];
  let userSchedule = null;

  // Fetch student's own schedule if timetable intent
  const needsPersonalSchedule = [
    'GET_TODAY_SCHEDULE',
    'GET_TOMORROW_SCHEDULE',
    'GET_DATE_SCHEDULE',
    'FIND_PERSONAL_AVAILABILITY',
    'GET_WEEKLY_SCHEDULE_INSIGHTS',
    'GET_BUSY_DAY',
    'GET_LIGHTEST_DAY',
    'GET_LONGEST_FREE_SLOT'
  ].includes(intent);

  if (needsPersonalSchedule) {
    if (!targetGroupId) {
      answer = `You haven't joined a campus squad yet. Go to **My Squads** to create or join a squad first, then upload your timetable!`;
      return sendResponse(res, answer, intent, executionTier, db, uid, timezone, ['Help me create a squad', 'How to import Excel']);
    }

    try {
      // Security check: verify user is in group members
      const memberSnap = await db.doc(`groups/${targetGroupId}/members/${uid}`).get();
      if (!memberSnap.exists) {
        answer = `You are not an active member of this squad. Please switch to your active squad using the top dropdown.`;
        return sendResponse(res, answer, intent, executionTier, db, uid, timezone, ['Help with squads']);
      }

      const schedSnap = await db.doc(`groups/${targetGroupId}/schedules/${uid}`).get();
      userSchedule = schedSnap.exists ? schedSnap.data().schedule : null;
    } catch (err) {
      console.error('Error fetching personal schedule:', err);
      return res.status(500).json({ error: 'Failed to access schedule records.' });
    }
  }

  // Dispatch intent calculations
  switch (intent) {
    case 'GREETING': {
      answer = `👋 Hello! I am your **UniSync Campus Assistant**.\n\nI can help you check your timetable, find personal free periods, and coordinate study sessions or hangouts with your squad.\n\nHow can I help you today?`;
      suggestedPrompts = [
        'What classes do I have today?',
        'What classes do I have tomorrow?',
        'When am I free today?',
        'When can my squad meet?'
      ];
      break;
    }

    case 'GET_TODAY_SCHEDULE':
    case 'GET_TOMORROW_SCHEDULE':
    case 'GET_DATE_SCHEDULE': {
      if (!userSchedule || Object.keys(userSchedule).length === 0) {
        answer = `You haven't uploaded a timetable for this squad yet.\n\nGo to **My Timetable** to upload your Excel schedule or add classes manually.`;
        suggestedPrompts = ['How do I import my timetable?', 'Add class manually'];
        break;
      }

      const dayLabel = intent === 'GET_TODAY_SCHEDULE'
        ? `Today (${targetDay})`
        : (intent === 'GET_TOMORROW_SCHEDULE' ? `Tomorrow (${targetDay})` : targetDay);

      const classes = getClassesForDay(userSchedule, targetDay);

      if (classes.length === 0) {
        answer = `🎉 You have **no classes scheduled** for **${dayLabel}**. You are completely free!`;
        suggestedPrompts = ['When can my squad meet?', 'Check tomorrow schedule', 'Weekly schedule insights'];
      } else {
        const classListMd = classes.map((c, i) => {
          const roomStr = c.room ? ` · Room **${c.room}**` : '';
          const typeStr = c.typeLabel ? ` (${c.typeLabel})` : '';
          return `${i + 1}. **${formatTime12(c.startTime)} – ${formatTime12(c.endTime)}** — **${c.subject}**${typeStr}${roomStr}`;
        }).join('\n');

        answer = `Here is your schedule for **${dayLabel}** (${classes.length} class${classes.length > 1 ? 'es' : ''}):\n\n${classListMd}`;
        suggestedPrompts = ['When am I free tomorrow?', 'Weekly schedule insights', 'What is my busiest day?'];
      }
      break;
    }

    case 'FIND_PERSONAL_AVAILABILITY': {
      if (!userSchedule || Object.keys(userSchedule).length === 0) {
        answer = `No timetable found for this squad. Please upload your timetable under **My Timetable** first.`;
        suggestedPrompts = ['How do I import my timetable?'];
        break;
      }

      const slots = findFreeSlotsForDay(userSchedule, targetDay);
      if (slots.length === 0) {
        answer = `You have continuous classes between 08:00 and 18:00 on **${targetDay}** with no free gaps of 30 mins or more.`;
        suggestedPrompts = ['Show my classes for ' + targetDay, 'What about tomorrow?'];
      } else {
        const slotList = slots.map(s => `• **${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}** (${formatDuration(s.durationMins)})`).join('\n');
        answer = `Here are your free windows on **${targetDay}** (active hours 08:00–18:00):\n\n${slotList}`;
        suggestedPrompts = ['When can my squad meet?', 'What is my longest free slot?', 'Show schedule for ' + targetDay];
      }
      break;
    }

    case 'FIND_COMMON_SQUAD_AVAILABILITY':
    case 'SUGGEST_MEETING_TIMES': {
      if (!targetGroupId) {
        answer = `Please select or join a squad first to check squad availability.`;
        suggestedPrompts = ['Help me create a squad', 'Help me join a squad'];
        break;
      }

      // Security authorization: verify user is in group members
      const memberSnap = await db.doc(`groups/${targetGroupId}/members/${uid}`).get();
      if (!memberSnap.exists) {
        return res.status(403).json({ error: 'Access denied: You are not a member of this squad.' });
      }

      const dayToCheck = targetDay || timeContext.dayName;

      // Fetch squad members and their schedules
      const membersSnap = await db.collection(`groups/${targetGroupId}/members`).get();
      const squadStudents = [];

      for (const mDoc of membersSnap.docs) {
        const sSnap = await db.doc(`groups/${targetGroupId}/schedules/${mDoc.id}`).get();
        if (sSnap.exists && sSnap.data().schedule) {
          squadStudents.push({
            name: mDoc.data().name || 'Member',
            schedule: sSnap.data().schedule
          });
        }
      }

      if (squadStudents.length === 0) {
        answer = `No schedules have been uploaded by squad members yet. Encourage your friends to upload their timetables!`;
        suggestedPrompts = ['How to upload timetable', 'My schedule today'];
        break;
      }

      const commonSlots = findCommonFreeSlotsAcrossStudents(squadStudents, dayToCheck, { minDuration: 30 });

      if (commonSlots.length === 0) {
        answer = `No common free time found on **${dayToCheck}** where all ${squadStudents.length} squad members with schedules are simultaneously free.\n\nTry checking another day or checking with a smaller subgroup under **Free Slots**.`;
        suggestedPrompts = ['Check availability for tomorrow', 'Suggest meeting times for Monday', 'My classes today'];
      } else {
        const slotsMd = commonSlots.map((s, i) => `${i + 1}. **${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}** (${formatDuration(s.durationMins)})`).join('\n');

        if (intent === 'SUGGEST_MEETING_TIMES') {
          const topSlots = commonSlots.slice(0, 3);
          const topMd = topSlots.map((s, i) => `**Option ${i + 1}:** ${formatTime12(s.startTime)} – ${formatTime12(s.endTime)} (${formatDuration(s.durationMins)})`).join('\n');
          answer = `📅 **Recommended Meeting Slots on ${dayToCheck}** (all ${squadStudents.length} squad members free):\n\n${topMd}\n\n*Note: To send invitations, open the **Meetings** tab and click **+ Schedule Meeting**.*`;
        } else {
          answer = `👥 **Common Squad Free Windows on ${dayToCheck}** (${squadStudents.length} members synced):\n\n${slotsMd}\n\nEveryone in your squad is out of class during these intervals!`;
        }
        suggestedPrompts = ['Suggest meeting times', 'When am I free tomorrow?', 'Weekly schedule insights'];
      }
      break;
    }

    case 'GET_WEEKLY_SCHEDULE_INSIGHTS': {
      if (!userSchedule || Object.keys(userSchedule).length === 0) {
        answer = `No timetable uploaded yet. Upload your schedule to see weekly class statistics!`;
        suggestedPrompts = ['How do I import my timetable?'];
        break;
      }

      const insights = calculateWeeklyInsights(userSchedule);
      const rows = DAY_ORDER.filter(d => insights.dayBreakdown[d]?.classCount > 0).map(d => {
        const info = insights.dayBreakdown[d];
        return `• **${d}:** ${info.classCount} class${info.classCount > 1 ? 'es' : ''} (${info.durationFormatted})`;
      }).join('\n');

      answer = `📊 **Weekly Schedule Insights:**\n\n• **Total Class Time:** ${insights.totalClassHours} hours across ${insights.totalClasses} classes.\n• **Busiest Day:** **${insights.busyDay || 'None'}**\n• **Lightest Day:** **${insights.lightestDay || 'None'}**\n\n**Day-by-Day Breakdown:**\n${rows || 'No classes recorded.'}`;
      suggestedPrompts = ['What is my busiest day?', 'What is my longest free slot?', 'My classes tomorrow'];
      break;
    }

    case 'GET_BUSY_DAY': {
      if (!userSchedule) {
        answer = `Please upload your timetable first to view your busiest day.`;
        break;
      }
      const insights = calculateWeeklyInsights(userSchedule);
      if (!insights.busyDay) {
        answer = `You currently have no classes scheduled this week!`;
      } else {
        const dayInfo = insights.dayBreakdown[insights.busyDay];
        answer = `Your busiest day is **${insights.busyDay}** with **${dayInfo.classCount} classes** totaling **${dayInfo.durationFormatted}** in lecture/lab halls.`;
      }
      suggestedPrompts = ['What is my lightest day?', 'Show classes on ' + (insights.busyDay || 'Monday'), 'Weekly insights'];
      break;
    }

    case 'GET_LIGHTEST_DAY': {
      if (!userSchedule) {
        answer = `Please upload your timetable first to view your lightest day.`;
        break;
      }
      const insights = calculateWeeklyInsights(userSchedule);
      if (!insights.lightestDay) {
        answer = `You currently have no classes scheduled this week!`;
      } else {
        const dayInfo = insights.dayBreakdown[insights.lightestDay];
        answer = `Your lightest academic day is **${insights.lightestDay}** with only **${dayInfo.classCount} class${dayInfo.classCount > 1 ? 'es' : ''}** (${dayInfo.durationFormatted}).`;
      }
      suggestedPrompts = ['What is my busiest day?', 'When am I free on ' + (insights.lightestDay || 'Friday'), 'Weekly insights'];
      break;
    }

    case 'GET_LONGEST_FREE_SLOT': {
      if (!userSchedule) {
        answer = `Please upload your timetable first to calculate your longest free slot.`;
        break;
      }
      const longest = getLongestFreeSlot(userSchedule);
      if (!longest) {
        answer = `You have no gaps between classes on your active timetable.`;
      } else {
        answer = `Your single longest free window of the week is on **${longest.day}** from **${formatTime12(longest.startTime)} to ${formatTime12(longest.endTime)}** (${formatDuration(longest.durationMins)} uninterrupted).`;
      }
      suggestedPrompts = ['When can my squad meet on ' + (longest?.day || 'Monday') + '?', 'Weekly insights'];
      break;
    }

    case 'GENERAL_UNISYNC_HELP': {
      const topic = rawParams.helpTopic || 'general';
      answer = getHelpResponse(topic);
      suggestedPrompts = ['How do I create a squad?', 'How do I import my timetable?', 'My classes tomorrow'];
      break;
    }

    case 'UNKNOWN_INTENT':
    default: {
      answer = `I am your **UniSync Campus Assistant**. I can help you query your timetable, find free periods, and coordinate with your squad.\n\nHere are things you can ask me:\n• *"What classes do I have tomorrow?"*\n• *"When am I free on Friday?"*\n• *"When are our squad members free to meet?"*\n• *"Which day is my heaviest schedule?"*\n• *"How do I import my timetable?"*`;
      suggestedPrompts = ['My classes tomorrow', 'When am I free?', 'Weekly schedule insights', 'When can my squad meet?'];
      break;
    }
  }

  return sendResponse(res, answer, intent, executionTier, db, uid, timezone, suggestedPrompts);
}

async function sendResponse(res, text, intent, executionTier, db, uid, timezone, suggestedPrompts = []) {
  const quota = await getUserRemainingAllowance(db, uid, timezone);
  return res.status(200).json({
    answer: text,
    intent,
    tier: executionTier,
    remainingUserQuota: quota.remaining,
    dailyLimit: quota.limit,
    suggestedPrompts
  });
}
