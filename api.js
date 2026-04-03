import { geminiApiKey } from './config.js';

/**
 * Scans a timetable image using Gemini 2.0 Flash Vision.
 * Returns { classes, schedule } in the same shape as parseLpuExcel().
 *
 * schedule: { Monday: { "10:20 - 11:10": { status, subject, room, type, typeLabel, batch, startTime, endTime } }, ... }
 * classes:  [ { day, startTime, endTime, subject, type, typeLabel, room, batch }, ... ]
 */
export async function scanTimetableImage(file) {
  // ── 1. Convert file → base64 ──────────────────────────────────────────────
  const base64Data = await fileToBase64(file);
  const mimeType   = file.type || 'image/png';

  // ── 2. Build prompt ───────────────────────────────────────────────────────
  const prompt = `You are an expert LPU (Lovely Professional University) timetable parser.
Carefully examine this timetable image and extract EVERY class entry.

CRITICAL RULES:
1. DO NOT guess, hallucinate, or add any classes that are not explicitly written in the timetable image.
2. ONLY extract classes visible in the grid. If a cell is blank or says "LUNCH", ignore it.
3. GRID ALIGNMENT IS CRITICAL: Pay EXTREMELY close attention to the Row (Day) and Column (Time) headers. Trace lines carefully. Do not mistakenly attribute a Friday class to Thursday, or vice versa. Double-check horizontal and vertical alignments for every single class!
4. Your output must ONLY be a valid JSON array of objects. No markdown, no preface text.

Each element must be an object with exactly these fields:
  "day"       : full weekday name, e.g. "Monday", "Tuesday" ... "Saturday"
  "startTime" : 24-hour time string "HH:MM", e.g. "10:20"
  "endTime"   : 24-hour time string "HH:MM", e.g. "11:10"
  "subject"   : subject / course code, e.g. "PES319"
  "type"      : single letter — "L" (Lecture), "T" (Tutorial), or "P" (Practical)
  "room"      : room number / code, e.g. "36-809"
  "batch"     : batch code if visible, e.g. "323MB", or empty string ""

Common LPU time slots for reference (but extract whatever time is in the image):
09:30-10:20, 10:20-11:10, 11:10-12:00, 12:00-12:50, 12:50-13:40,
13:40-14:30, 14:30-15:20, 15:20-16:10, 21:00-22:00

Return ONLY the JSON array. Example:
[
  {"day":"Monday","startTime":"10:20","endTime":"11:10","subject":"PES319","type":"L","room":"36-809","batch":"323MB"},
  {"day":"Wednesday","startTime":"09:30","endTime":"10:20","subject":"CSE205","type":"T","room":"12-201","batch":""}
]`;

  // ── 3. Call Gemini 2.5 Flash ──────────────────────────────────────────────
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64Data } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096
    }
  };

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort('Timeout reached'), 90000); // 90s timeout

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(requestBody),
      signal:  controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  // ── 4. Parse response ─────────────────────────────────────────────────────
  const data       = await response.json();
  const resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

  let rawClasses;
  try {
    // Highly resilient JSON array extraction: grab everything from first [ to last ]
    const arrayMatch = resultText.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      // Fallback: perhaps it returned an object containing the array
      const objMatch = resultText.match(/\{[\s\S]*\}/);
      if (objMatch) {
         let cleanedObjText = objMatch[0].replace(/,\s*([\}\]])/g, '$1'); // remove trailing commas
         const parsedObj = JSON.parse(cleanedObjText);
         rawClasses = parsedObj.classes || Object.values(parsedObj)[0] || [];
      } else {
         throw new Error("No JSON structure found");
      }
    } else {
      let cleanedArrayText = arrayMatch[0].replace(/,\s*([\}\]])/g, '$1'); // remove trailing commas
      rawClasses = JSON.parse(cleanedArrayText);
    }
  } catch (e) {
    console.error("Failed to parse Gemini output:", resultText);
    throw new Error('JSON parsing failed. E.g. unexpected character. Raw output snippet: ' + (resultText.slice(0, 150) || 'None'));
  }

  if (!Array.isArray(rawClasses) || rawClasses.length === 0) {
    throw new Error('No classes detected in the image. Please try a higher-quality screenshot.');
  }

  // ── 5. Normalise into schedule map ────────────────────────────────────────
  const TYPE_LABEL = { L: 'Lecture', T: 'Tutorial', P: 'Practical' };
  const DAY_ORDER  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  const classes  = [];
  const schedule = {};

  for (const entry of rawClasses) {
    const day       = (entry.day || '').trim();
    const startTime = normaliseTime(entry.startTime);
    const endTime   = normaliseTime(entry.endTime);
    const subject   = (entry.subject || '').trim();
    const type      = (entry.type    || 'L').trim().toUpperCase();
    const room      = (entry.room    || '').trim();
    const batch     = (entry.batch   || '').trim();

    if (!day || !startTime || !endTime || !subject) continue;
    if (!DAY_ORDER.includes(day)) continue;

    const typeLabel = TYPE_LABEL[type] || type;
    const slotKey   = `${startTime} - ${endTime}`;

    if (!schedule[day]) schedule[day] = {};

    schedule[day][slotKey] = {
      status:    'busy',
      subject,
      room,
      type,
      typeLabel,
      batch,
      startTime,
      endTime
    };

    classes.push({ day, startTime, endTime, subject, type, typeLabel, room, batch });
  }

  // Sort classes by day order then start time
  classes.sort((a, b) => {
    const dDiff = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
    return dDiff !== 0 ? dDiff : a.startTime.localeCompare(b.startTime);
  });

  return { classes, schedule };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a File to plain base64 (no data-URL prefix). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      const dataUrl = reader.result;         // "data:image/png;base64,iVBOR..."
      resolve(dataUrl.split(',')[1]);        // strip prefix, return raw base64
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

/** Ensure time is "HH:MM" format. Accepts "10:20", "10:20:00", "1020" etc. */
function normaliseTime(t) {
  if (!t) return '';
  const s = String(t).trim();
  // Already "HH:MM"
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  // "HH:MM:SS"
  const hms = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hms) return hms[1].padStart(2, '0') + ':' + hms[2];
  // "HHMM"
  const compact = s.match(/^(\d{2})(\d{2})$/);
  if (compact) return compact[1] + ':' + compact[2];
  return s;
}
