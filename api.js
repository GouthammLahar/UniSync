import { geminiApiKey } from './config.js?v=8';
import { normaliseTime, DAY_ORDER, TYPE_LABEL_MAP } from './schedule-utils.js?v=8';

/**
 * Scans a timetable image using Gemini Vision AI.
 * Universal support for any university timetable (50m, 60m, 45m slots, 08:20/08:30 starts, multi-hour labs).
 *
 * Returns:
 * {
 *   classes:  [ { day, startTime, endTime, subject, type, typeLabel, room, batch }, ... ],
 *   schedule: { Monday: { "08:30 - 09:20": { status, subject, room, type, typeLabel, batch, startTime, endTime } }, ... }
 * }
 */
export async function scanTimetableImage(file) {
  if (!geminiApiKey || geminiApiKey === 'your_gemini_api_key_here' || geminiApiKey.trim() === '') {
    throw new Error('Gemini API key is not configured. Please add VITE_GEMINI_API_KEY in your .env file.');
  }

  // ── 1. Convert file → base64 ──────────────────────────────────────────────
  const base64Data = await fileToBase64(file);
  const mimeType   = file.type || 'image/png';

  // ── 2. Universal Vision Prompt ────────────────────────────────────────────
  const prompt = `You are a precision timetable and schedule extraction system.
Carefully examine this university / college timetable image and extract EVERY scheduled class or lab with complete accuracy.

CRITICAL INSTRUCTIONS FOR ACCURACY:
1. READ COLUMN HEADERS FOR EXACT TIMES:
   - Locate the header row or column that lists the exact time ranges for each period.
   - Do NOT assume standard or fixed 1-hour slots. Different colleges have different start times and durations!
   - Examples of actual period headers:
     * 08:20 - 09:10 (50 min)
     * 08:30 - 09:20 (50 min)
     * 09:25 - 10:15 (50 min)
     * 09:00 - 10:00 (60 min)
     * 10:20 - 11:10
   - Read the EXACT numbers printed in the column header for each period.
   - Always convert start and end times to 24-hour "HH:MM" format (e.g., "8:30 AM" or "8:30" -> "08:30", "1:40 PM" -> "13:40").

2. READ ROW HEADERS FOR DAYS:
   - Identify the days of the week (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday).
   - Trace row grid lines carefully so classes are attributed to their exact day.

3. HANDLE MULTI-PERIOD LABS / PRACTICALS:
   - If a lab or workshop spans across 2 or more consecutive time columns (e.g. 08:30 to 10:20 or 14:00 to 16:00), record:
     * startTime = start time of the first period
     * endTime = end time of the last period spanned

4. EXTRACT CELL DETAILS:
   - "day": full weekday name ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
   - "startTime": 24-hour time "HH:MM" (e.g. "08:30", "08:20", "09:00", "13:40")
   - "endTime": 24-hour time "HH:MM" (e.g. "09:20", "09:10", "10:00", "14:30")
   - "subject": course code or subject title (e.g. "PES319", "Data Structures", "CSE205")
   - "type": "L" for Lecture/Theory, "T" for Tutorial, "P" for Practical/Lab/Workshop
   - "room": room / classroom / lab code if visible (e.g. "36-809", "LT-2", "Lab 4"), or empty string ""
   - "batch": section / batch if visible (e.g. "323MB", "Batch A"), or empty string ""

5. EXCLUDE NON-CLASSES:
   - DO NOT include empty cells, "LUNCH", "BREAK", "RECESS", "FREE", or library study periods.
   - DO NOT hallucinate or guess any class not visible in the image.

Output ONLY a JSON array of objects conforming to the schema.`;

  // ── 3. Call Gemini API (with automatic model fallback) ─────────────────────
  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64Data } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            day: { type: 'STRING' },
            startTime: { type: 'STRING' },
            endTime: { type: 'STRING' },
            subject: { type: 'STRING' },
            type: { type: 'STRING' },
            room: { type: 'STRING' },
            batch: { type: 'STRING' }
          },
          required: ['day', 'startTime', 'endTime', 'subject']
        }
      }
    }
  };

  const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let rawResponseText = null;
  let lastError = null;

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('Timeout reached'), 60000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        lastError = new Error(`Gemini (${model}) ${response.status}: ${errText.slice(0, 150)}`);
        // If 404 Not Found (e.g. model deprecated/unsupported in region), try next model
        if (response.status === 404) continue;
        throw lastError;
      }

      const data = await response.json();
      rawResponseText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
      break; // Success!
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        throw new Error('Gemini request timed out. Please try again with a smaller or clearer image.');
      }
      // If network failed and we have another model, try next
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!rawResponseText) {
    throw lastError || new Error('Failed to communicate with Gemini API.');
  }

  // ── 4. Parse JSON Response ────────────────────────────────────────────────
  let rawClasses = [];
  try {
    const arrayMatch = rawResponseText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const cleaned = arrayMatch[0].replace(/,\s*([\}\]])/g, '$1');
      rawClasses = JSON.parse(cleaned);
    } else {
      const parsed = JSON.parse(rawResponseText);
      rawClasses = Array.isArray(parsed) ? parsed : (parsed.classes || Object.values(parsed)[0] || []);
    }
  } catch (e) {
    console.error('Failed to parse Gemini output:', rawResponseText);
    throw new Error('Failed to parse timetable from image. Raw preview: ' + rawResponseText.slice(0, 100));
  }

  if (!Array.isArray(rawClasses) || rawClasses.length === 0) {
    throw new Error('No classes detected in the image. Please ensure the screenshot is clear and shows table headers.');
  }

  // ── 5. Normalise into classes & schedule ──────────────────────────────────
  const classes = [];
  const schedule = {};

  for (const entry of rawClasses) {
    const day = (entry.day || '').trim();
    const startTime = normaliseTime(entry.startTime);
    const endTime = normaliseTime(entry.endTime);
    const subject = (entry.subject || '').trim();
    const rawType = (entry.type || 'L').trim().toUpperCase();
    const room = (entry.room || '').trim();
    const batch = (entry.batch || '').trim();

    if (!day || !startTime || !endTime || !subject) continue;
    if (!DAY_ORDER.includes(day)) continue;

    const type = (rawType.startsWith('P') || rawType === 'LAB') ? 'P' : (rawType.startsWith('T') ? 'T' : 'L');
    const typeLabel = TYPE_LABEL_MAP[type] || 'Lecture';
    const slotKey = `${startTime} - ${endTime}`;

    if (!schedule[day]) schedule[day] = {};

    schedule[day][slotKey] = {
      status: 'busy',
      subject,
      room,
      type,
      typeLabel,
      batch,
      startTime,
      endTime
    };

    classes.push({
      day,
      startTime,
      endTime,
      subject,
      type,
      typeLabel,
      room,
      batch
    });
  }

  // Sort classes by day order then start time
  classes.sort((a, b) => {
    const dDiff = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
    return dDiff !== 0 ? dDiff : a.startTime.localeCompare(b.startTime);
  });

  return { classes, schedule };
}

// ── Helper: File to plain base64 ──────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}
