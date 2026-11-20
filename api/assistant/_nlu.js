/**
 * api/assistant/_nlu.js
 * Natural Language Understanding for UniSync Assistant.
 * Multi-tier: Level 1 (Deterministic) -> Level 2 (Gemini NLU) -> Level 3 (Fallback parser).
 * ZERO schedule or private data is ever passed to Gemini.
 */

import { DAY_ORDER } from './_logic.js';

export const ALLOWED_INTENTS = [
  'GREETING',
  'GET_TODAY_SCHEDULE',
  'GET_TOMORROW_SCHEDULE',
  'GET_DATE_SCHEDULE',
  'FIND_PERSONAL_AVAILABILITY',
  'FIND_COMMON_SQUAD_AVAILABILITY',
  'GET_WEEKLY_SCHEDULE_INSIGHTS',
  'GET_BUSY_DAY',
  'GET_LIGHTEST_DAY',
  'GET_LONGEST_FREE_SLOT',
  'SUGGEST_MEETING_TIMES',
  'GENERAL_UNISYNC_HELP',
  'UNKNOWN_INTENT'
];

/**
 * Level 1: Fast deterministic intent matcher for common queries.
 * Returns null if no high-confidence deterministic match.
 */
export function matchDeterministicIntent(queryText, context = {}) {
  const q = (queryText || '').toLowerCase().trim();

  // Greetings
  if (/^(hi|hello|hey|heyy+|greetings|good (morning|afternoon|evening)|howdy|sup)\b/i.test(q)) {
    return {
      intent: 'GREETING',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // Help queries
  if (q === 'help' || q.includes('how to use unisync') || q.includes('how do i') || q.includes('help me')) {
    return {
      intent: 'GENERAL_UNISYNC_HELP',
      confidence: 'deterministic',
      parameters: { helpTopic: extractHelpTopic(q) }
    };
  }

  // Today's classes
  if (/^(what('s| is| are)? (my|today'?s) (classes|schedule|lectures)|my classes today|schedule today|today'?s classes|what do i have today)/i.test(q)) {
    return {
      intent: 'GET_TODAY_SCHEDULE',
      confidence: 'deterministic',
      parameters: { day: context.currentDayName }
    };
  }

  // Tomorrow's classes
  if (/^(what('s| is| are)? (my|tomorrow'?s) (classes|schedule|lectures)|my classes tomorrow|classes tomorrow|schedule tomorrow|what do i have tomorrow)/i.test(q)) {
    return {
      intent: 'GET_TOMORROW_SCHEDULE',
      confidence: 'deterministic',
      parameters: { day: context.tomorrowDayName }
    };
  }

  // Specific Day Schedule
  for (const day of DAY_ORDER) {
    const dayRegex = new RegExp(`\\b(on |for )?${day}\\b`, 'i');
    if (dayRegex.test(q) && /(class|schedule|lecture|timetable)/i.test(q) && !/(free|available|open)/i.test(q)) {
      return {
        intent: 'GET_DATE_SCHEDULE',
        confidence: 'deterministic',
        parameters: { day }
      };
    }
  }

  // Busiest / Lightest day
  if (/(busiest|heaviest|most classes)/i.test(q)) {
    return {
      intent: 'GET_BUSY_DAY',
      confidence: 'deterministic',
      parameters: {}
    };
  }
  if (/(lightest|least classes|easiest day)/i.test(q)) {
    return {
      intent: 'GET_LIGHTEST_DAY',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // Weekly insights / hours
  if (/(weekly insights|how many (class )?hours|total classes this week|weekly breakdown|weekly schedule)/i.test(q) && !/(squad|meet)/i.test(q)) {
    return {
      intent: 'GET_WEEKLY_SCHEDULE_INSIGHTS',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // Longest free slot
  if (/(longest free (period|slot|time|window)|biggest gap)/i.test(q)) {
    return {
      intent: 'GET_LONGEST_FREE_SLOT',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // When can squad meet / common free time
  if (/(when can (my |our )?squad meet|common free time|squad availability|when are (we|most of us|friends) free)/i.test(q)) {
    return {
      intent: 'FIND_COMMON_SQUAD_AVAILABILITY',
      confidence: 'deterministic',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // Meeting suggestions
  if (/(suggest (meeting |a )?time|propose (a )?meeting|meeting options|when should we meet)/i.test(q)) {
    return {
      intent: 'SUGGEST_MEETING_TIMES',
      confidence: 'deterministic',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // Personal availability: free tomorrow, free today, when am i free
  if (/(when am i free|my free (time|slots|periods)|am i free)/i.test(q)) {
    let day = extractDay(q);
    if (!day) {
      if (q.includes('tomorrow')) day = context.tomorrowDayName;
      else day = context.currentDayName;
    }
    return {
      intent: 'FIND_PERSONAL_AVAILABILITY',
      confidence: 'deterministic',
      parameters: { day }
    };
  }

  return null;
}

function extractHelpTopic(q) {
  if (q.includes('squad') || q.includes('group')) return 'squads';
  if (q.includes('import') || q.includes('excel') || q.includes('timetable') || q.includes('upload')) return 'timetable';
  if (q.includes('friend')) return 'friends';
  if (q.includes('meeting')) return 'meetings';
  if (q.includes('privacy') || q.includes('security')) return 'privacy';
  return 'general';
}

function extractDay(q) {
  for (const day of DAY_ORDER) {
    if (new RegExp(`\\b${day}\\b`, 'i').test(q)) return day;
  }
  return null;
}

/**
 * Level 2: Gemini NLU intent classification.
 * Converts unstructured student natural language into structured JSON intent.
 * ONLY the text query and reference calendar metadata are provided to Gemini.
 */
export async function extractIntentWithGemini(userText, context, apiKey) {
  if (!apiKey) throw new Error('NO_API_KEY');

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const now = new Date();
  const dateStr = context.currentDateStr || now.toISOString().split('T')[0];
  const dayName = context.currentDayName || DAY_ORDER[now.getDay() === 0 ? 6 : now.getDay() - 1];

  const systemPrompt = `You are a strict Intent Classification engine for UniSync, a university student timetable and squad collaboration app.
Current date reference: ${dateStr} (${dayName}). User timezone: ${context.userTimezone || 'Asia/Kolkata'}.

Given the student's question and optional recent turn, classify into EXACTLY ONE intent from this list:
- GREETING: Greetings or casual hellos (e.g. "hi", "hello", "hey there").
- GET_TODAY_SCHEDULE: Classes or timetable for today.
- GET_TOMORROW_SCHEDULE: Classes or timetable for tomorrow.
- GET_DATE_SCHEDULE: Classes or timetable for a specific day/date (e.g. "my schedule on Friday", "classes on Nov 25").
- FIND_PERSONAL_AVAILABILITY: When the student is free, gaps between classes, free time on a day.
- FIND_COMMON_SQUAD_AVAILABILITY: Finding free time when squad members / friends are mutually free.
- GET_WEEKLY_SCHEDULE_INSIGHTS: Total class hours, weekly schedule overview, class distribution across the week.
- GET_BUSY_DAY: Finding the student's busiest or heaviest class day.
- GET_LIGHTEST_DAY: Finding the student's lightest or easiest class day.
- GET_LONGEST_FREE_SLOT: Finding the single longest break or gap between classes.
- SUGGEST_MEETING_TIMES: Suggesting potential meeting slots for friends or squad.
- GENERAL_UNISYNC_HELP: Questions on how to use UniSync (squads, excel import, meetings, etc).
- UNKNOWN_INTENT: Questions completely unrelated to university scheduling or incomprehensible.

Rules:
1. Output ONLY a valid JSON object matching the schema.
2. Resolve relative days (e.g. "tomorrow", "this Friday", "next Monday") into the specific weekday name ("Monday", "Tuesday", etc).
3. If clarification is needed or request is ambiguous, set clarificationNeeded to true and provide a short clarificationQuestion.
4. Do NOT attempt to calculate actual free time or answer the question yourself. Your ONLY job is intent classification.`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          ...(context.recentTurn ? [{ text: `Previous Context: User asked "${context.recentTurn.user}", Assistant answered "${context.recentTurn.assistant}"` }] : []),
          { text: `Student Query: "${userText}"` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          intent: { type: 'STRING', enum: ALLOWED_INTENTS },
          day: { type: 'STRING' },
          date: { type: 'STRING' },
          timeRange: { type: 'STRING' },
          minDurationMinutes: { type: 'INTEGER' },
          clarificationNeeded: { type: 'BOOLEAN' },
          clarificationQuestion: { type: 'STRING' }
        },
        required: ['intent']
      }
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s fast timeout for NLU

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 429) {
        const quotaErr = new Error('GEMINI_QUOTA_EXCEEDED');
        quotaErr.status = 429;
        throw quotaErr;
      }
      throw new Error(`Gemini API error (HTTP ${response.status})`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('Empty response from Gemini');
    }

    const parsed = JSON.parse(rawText);
    if (parsed && ALLOWED_INTENTS.includes(parsed.intent)) {
      // Normalize day if given
      if (parsed.day && !DAY_ORDER.includes(parsed.day)) {
        const matchedDay = DAY_ORDER.find(d => d.toLowerCase() === parsed.day.toLowerCase());
        parsed.day = matchedDay || context.currentDayName;
      }
      return {
        intent: parsed.intent,
        confidence: 'ai',
        parameters: parsed
      };
    }
    throw new Error('Invalid intent received from Gemini');
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.message === 'GEMINI_QUOTA_EXCEEDED') throw err;
    throw new Error(err.message || 'Gemini NLU execution failed');
  }
}

/**
 * Level 3: Robust fallback classifier when Gemini fails or is unreachable.
 * Examines keywords and syntax tokens to deliver the most helpful intent.
 */
export function matchFallbackIntent(queryText, context = {}) {
  const q = (queryText || '').toLowerCase().trim();

  // 1. First run deterministic matcher
  const direct = matchDeterministicIntent(queryText, context);
  if (direct) return direct;

  // 2. Keyword heuristic breakdown
  const hasFree = /(free|availability|available|spare time|open slot|window|break|gap|go out|hang out|clear)/i.test(q);
  const hasClass = /(class|lecture|subject|timetable|period|schedule)/i.test(q);
  const hasSquad = /(squad|group|friends?|members?|together|everyone|we|us|roommates?)/i.test(q);
  const hasMeet = /(meet|meeting|hangout|study session|catch up)/i.test(q);

  let targetDay = extractDay(q);
  if (!targetDay) {
    if (q.includes('tomorrow')) targetDay = context.tomorrowDayName;
    else if (q.includes('today')) targetDay = context.currentDayName;
  }

  if (hasMeet) {
    return {
      intent: 'SUGGEST_MEETING_TIMES',
      confidence: 'fallback',
      parameters: { day: targetDay || context.currentDayName }
    };
  }

  if (hasSquad && hasFree) {
    return {
      intent: 'FIND_COMMON_SQUAD_AVAILABILITY',
      confidence: 'fallback',
      parameters: { day: targetDay || context.currentDayName }
    };
  }

  if (hasFree) {
    return {
      intent: 'FIND_PERSONAL_AVAILABILITY',
      confidence: 'fallback',
      parameters: { day: targetDay || context.currentDayName }
    };
  }

  if (hasClass) {
    if (targetDay === context.tomorrowDayName) {
      return {
        intent: 'GET_TOMORROW_SCHEDULE',
        confidence: 'fallback',
        parameters: { day: targetDay }
      };
    }
    if (targetDay) {
      return {
        intent: 'GET_DATE_SCHEDULE',
        confidence: 'fallback',
        parameters: { day: targetDay }
      };
    }
    return {
      intent: 'GET_TODAY_SCHEDULE',
      confidence: 'fallback',
      parameters: { day: context.currentDayName }
    };
  }

  return {
    intent: 'UNKNOWN_INTENT',
    confidence: 'fallback',
    parameters: {}
  };
}
