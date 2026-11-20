/**
 * api/assistant/_nlu.js
 * Natural Language Understanding for UniSync Assistant.
 * Multi-tier: Level 1 (Deterministic) -> Level 2 (Gemini NLU) -> Level 3 (Fallback parser).
 * ZERO schedule or private data is ever passed to Gemini.
 */

import { DAY_ORDER } from './_logic.js';

export const ALLOWED_INTENTS = [
  'GREETING',
  'ACADEMIC_ATTENDANCE_QUERY',
  'PRODUCTIVITY_AND_BALANCE',
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

  // 1. Pure standalone greetings (do NOT match if followed by a substantive question)
  if (/^(hi|hello|hey|heyy+|greetings|good (morning|afternoon|evening)|howdy|sup|how are you|hello, how are you|hi how are you)([ ,!.]+(there|assistant|bot|unisync)?)?[.!?]*$/i.test(q)) {
    return {
      intent: 'GREETING',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // 2. Direct Academic & Attendance Queries
  if (/(attendance|attendance percentage|my attendance|academic performance|marks|grades|cgpa|gpa|exam results?)/i.test(q)) {
    return {
      intent: 'ACADEMIC_ATTENDANCE_QUERY',
      confidence: 'deterministic',
      parameters: {
        asksAttendance: /attendance/i.test(q),
        asksPerformance: /(performance|marks|grades|cgpa|gpa|exam)/i.test(q),
        asksStruggle: /(struggle|difficult|hard|fail)/i.test(q)
      }
    };
  }

  // 3. Direct Productivity, Balance & Routine queries
  if (/(improve (my )?(weekly )?routine|balance (work|study|academic)|spend time with friends without affecting|suggest a plan|plan my week|when can i relax|manage my academic work)/i.test(q)) {
    return {
      intent: 'PRODUCTIVITY_AND_BALANCE',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // 4. Help queries
  if (q === 'help' || q.includes('how to use unisync') || q.includes('how do i') || q.includes('help me')) {
    return {
      intent: 'GENERAL_UNISYNC_HELP',
      confidence: 'deterministic',
      parameters: { helpTopic: extractHelpTopic(q) }
    };
  }

  // 5. Today's classes
  if (/^(what('s| is| are)? (my|today'?s) (classes|schedule|lectures)|my classes today|schedule today|today'?s classes|what do i have today)[.!?]?$/i.test(q)) {
    return {
      intent: 'GET_TODAY_SCHEDULE',
      confidence: 'deterministic',
      parameters: { day: context.currentDayName }
    };
  }

  // 6. Tomorrow's classes
  if (/^(what('s| is| are)? (my|tomorrow'?s) (classes|schedule|lectures)|my classes tomorrow|classes tomorrow|schedule tomorrow|what do i have tomorrow)[.!?]?$/i.test(q)) {
    return {
      intent: 'GET_TOMORROW_SCHEDULE',
      confidence: 'deterministic',
      parameters: { day: context.tomorrowDayName }
    };
  }

  // 7. Specific Day Schedule
  for (const day of DAY_ORDER) {
    const dayRegex = new RegExp(`\\b(on |for )?${day}\\b`, 'i');
    if (dayRegex.test(q) && /(class|schedule|lecture|timetable)/i.test(q) && !/(free|available|open|busy|light|relax|balance)/i.test(q)) {
      return {
        intent: 'GET_DATE_SCHEDULE',
        confidence: 'deterministic',
        parameters: { day }
      };
    }
  }

  // 8. Busiest / Lightest day
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

  // 9. Weekly insights / hours
  if (/^(weekly insights|how many (class )?hours|total classes this week|weekly breakdown|weekly schedule)[.!?]?$/i.test(q) && !/(squad|meet|relax|friend|balance)/i.test(q)) {
    return {
      intent: 'GET_WEEKLY_SCHEDULE_INSIGHTS',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // 10. Longest free slot
  if (/(longest free (period|slot|time|window)|biggest gap)/i.test(q)) {
    return {
      intent: 'GET_LONGEST_FREE_SLOT',
      confidence: 'deterministic',
      parameters: {}
    };
  }

  // 11. When can squad meet / common free time
  if (/(when can (my |our )?squad meet|common free time|squad availability|when are (we|most of us|friends) free)/i.test(q)) {
    return {
      intent: 'FIND_COMMON_SQUAD_AVAILABILITY',
      confidence: 'deterministic',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // 12. Meeting suggestions
  if (/(suggest (meeting |a )?time|propose (a )?meeting|meeting options|when should we meet)/i.test(q)) {
    return {
      intent: 'SUGGEST_MEETING_TIMES',
      confidence: 'deterministic',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // 13. Personal availability
  if (/^(when am i free|my free (time|slots|periods)|am i free)/i.test(q) && !/(squad|friend|relax|balance|routine)/i.test(q)) {
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
- GREETING: Polite greetings or conversational openers without complex requests (e.g. "hi", "hello", "how are you?").
- ACADEMIC_ATTENDANCE_QUERY: Questions asking about student attendance records, attendance percentage, grades, marks, GPA, academic performance, exam results, or struggling in courses.
- PRODUCTIVITY_AND_BALANCE: Questions seeking advice on balancing academic workload with social life or relaxation, managing busy weeks, planning weekly routines, or time management.
- GET_TODAY_SCHEDULE: Specifically asking for today's classes or schedule.
- GET_TOMORROW_SCHEDULE: Specifically asking for tomorrow's classes or schedule.
- GET_DATE_SCHEDULE: Asking for classes or timetable on a specific day or date (e.g. "my schedule on Friday", "classes on Nov 25").
- FIND_PERSONAL_AVAILABILITY: Asking when the student personally has free periods, gaps, or available hours on a specific day.
- FIND_COMMON_SQUAD_AVAILABILITY: Finding mutual free slots when squad members or friends are simultaneously out of class.
- GET_WEEKLY_SCHEDULE_INSIGHTS: Inquiring about total class hours across the week, weekly schedule overview, or general timetable statistics.
- GET_BUSY_DAY: Finding the student's heaviest or busiest academic class day.
- GET_LIGHTEST_DAY: Finding the student's lightest or easiest class day.
- GET_LONGEST_FREE_SLOT: Finding the single longest break or gap between classes in the timetable.
- SUGGEST_MEETING_TIMES: Requesting recommended meeting slots for friends or squad.
- GENERAL_UNISYNC_HELP: Questions on using UniSync features (Excel timetable import, squads, meetings, privacy).
- UNKNOWN_INTENT: Questions completely unrelated to university life, academics, or campus scheduling.

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

  // 2. Attendance & Academic Performance check (Phase 4)
  if (/(attendance|percentage|academic performance|performance|grade|marks|cgpa|gpa|exam results?|struggle|struggling|fail|most likely to struggle)/i.test(q)) {
    return {
      intent: 'ACADEMIC_ATTENDANCE_QUERY',
      confidence: 'fallback',
      parameters: {
        asksAttendance: /attendance/i.test(q),
        asksPerformance: /(performance|marks|grades|cgpa|gpa|exam)/i.test(q),
        asksStruggle: /(struggle|difficult|hard)/i.test(q)
      }
    };
  }

  // 3. Balance, Relaxation, Productivity, Routine check (Phase 2 & 3)
  if (/(relax|balance|routine|productivity|hang out with friends|spend time with friends|socialize|study plan|manage.*academic|manage.*study|busy week|suggest a plan)/i.test(q)) {
    return {
      intent: 'PRODUCTIVITY_AND_BALANCE',
      confidence: 'fallback',
      parameters: {}
    };
  }

  // 4. Meeting suggestions
  if (/(meet|meeting|study session|catch up)/i.test(q)) {
    return {
      intent: 'SUGGEST_MEETING_TIMES',
      confidence: 'fallback',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // 5. Squad availability
  if (/(squad|group|friends?|together|everyone|we|us)/i.test(q) && /(free|available|gap|time|window|go out|hang out|clear)/i.test(q)) {
    return {
      intent: 'FIND_COMMON_SQUAD_AVAILABILITY',
      confidence: 'fallback',
      parameters: { day: extractDay(q) || context.currentDayName }
    };
  }

  // 6. Personal free time
  if (/(free|available|open slot|window|break|gap|clear|spare time|open)/i.test(q)) {
    let targetDay = extractDay(q);
    if (!targetDay) {
      if (q.includes('tomorrow')) targetDay = context.tomorrowDayName;
      else if (q.includes('today')) targetDay = context.currentDayName;
    }
    return {
      intent: 'FIND_PERSONAL_AVAILABILITY',
      confidence: 'fallback',
      parameters: { day: targetDay || context.currentDayName }
    };
  }

  // 7. Explicit Schedule queries for a specific day
  let targetDay = extractDay(q);
  if (!targetDay) {
    if (q.includes('tomorrow')) targetDay = context.tomorrowDayName;
    else if (q.includes('today')) targetDay = context.currentDayName;
  }

  if (targetDay && /(class|lecture|schedule|timetable|subject)/i.test(q)) {
    return {
      intent: targetDay === context.tomorrowDayName ? 'GET_TOMORROW_SCHEDULE' : 'GET_DATE_SCHEDULE',
      confidence: 'fallback',
      parameters: { day: targetDay }
    };
  }

  // 8. General timetable query without specific day -> Weekly insights (NOT today's classes!)
  if (/(timetable|schedule|classes|lectures|subjects)/i.test(q)) {
    return {
      intent: 'GET_WEEKLY_SCHEDULE_INSIGHTS',
      confidence: 'fallback',
      parameters: {}
    };
  }

  return {
    intent: 'UNKNOWN_INTENT',
    confidence: 'fallback',
    parameters: {}
  };
}

/**
 * Phase 3: Hybrid generative synthesis using verified timetable facts.
 * Generates an empathetic, conversational, structured plan strictly grounded
 * in the student's actual timetable data (no hallucinations).
 */
export async function generateHybridAdviceWithGemini(userText, scheduleFacts, apiKey) {
  if (!apiKey) throw new Error('NO_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const systemPrompt = `You are the UniSync Campus Assistant, an encouraging academic advisor and university life coordinator.
The student is asking for advice, routine improvement, or how to balance academic study with relaxation and friends.

STRICT ACCURACY RULES:
1. Ground ALL scheduling statements strictly in the verified timetable facts below.
2. NEVER invent non-existent classes, extra free periods, or different class hours.
3. Keep the answer structured, encouraging, practical, and formatted in clean GitHub Markdown bullet points.
4. Directly answer the student's question (e.g. specifically addressing relaxation, socializing, or study routines).

VERIFIED TIMETABLE DATA:
- Total weekly academic load: ${scheduleFacts.totalClassHours} hours across ${scheduleFacts.totalClasses} classes
- Busiest day: ${scheduleFacts.busyDay || 'None'} (${scheduleFacts.busyClasses || 0} classes, ${scheduleFacts.busyDuration || '0h'})
- Lightest active day: ${scheduleFacts.lightestDay || 'None'} (${scheduleFacts.lightestClasses || 0} classes, ${scheduleFacts.lightestDuration || '0h'})
- Completely free days: ${scheduleFacts.freeDays?.length ? scheduleFacts.freeDays.join(', ') : 'None (has classes every weekday)'}
- Key free breaks between classes:
${scheduleFacts.keyFreeSlots?.map(s => `  • ${s.day}: ${s.time} (${s.duration})`).join('\n') || '  • Standard evening hours after classes'}
- Enrolled subjects: ${scheduleFacts.subjects?.map(s => `${s.subject} (${s.classCount} classes/wk)`).join(', ') || 'General courses'}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: `Student Question: "${userText}"` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 600
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Gemini API error (HTTP ${response.status})`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');
    return text.trim();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
