/**
 * timetable-parser.js
 * Parses LPU timetable Excel (.xlsx) files using SheetJS.
 * Returns a schedule object keyed by day → slot string → class data.
 *
 * Supports two Excel cell formats:
 *
 *   FORMAT A – old LPU layout (cell contains timing + class details):
 *     "10:20 - 11:10:\n36-809 - L - PES319 B1"
 *
 *   FORMAT B – new LPU layout (cell contains class details only; timing in a
 *     separate column):
 *     "Lecture / G:All C:PES390 / R: 34-213\n / S:K3E0054"
 *     "Lecture / G:All C:INT364 / R: 34-401 ( Makeup Class )\n / S:K2EM055"
 *
 * Both formats share the same return shape:
 *   { studentId, classes[], schedule{} }
 *
 * Layout detection:
 *   - Day headers (Monday/Mon/MONDAY etc.) may appear in any of the first 10 rows.
 *   - Full and abbreviated weekday names are both recognized.
 *   - Mixed capitalisation, extra whitespace, and merged/empty cells are handled.
 *   - Timing column is detected automatically (contains HH:MM patterns).
 *   - Student ID is scanned from any row above the header row.
 */
import * as XLSX from 'xlsx';

export const LPU_SLOTS = [
  "09:30 - 10:20",
  "10:20 - 11:10",
  "11:10 - 12:00",
  "12:00 - 12:50",
  "12:50 - 13:40",
  "13:40 - 14:30",
  "14:00 - 15:00",
  "14:30 - 15:20",
  "15:20 - 16:10",
  "21:00 - 22:00"
];

const TYPE_MAP = { L: 'Lecture', T: 'Tutorial', P: 'Practical' };
const CLASS_TYPE_CODE = { lecture: 'L', tutorial: 'T', practical: 'P' };

/**
 * Canonical day order used throughout UniSync for sorting and display.
 */
const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

/**
 * Map of lowercase day name variants (full + abbreviated) to canonical day names.
 * Handles full names, 2-3 letter abbreviations, and common alternate spellings.
 */
const DAY_ALIASES = {
  'monday':    'Monday',
  'mon':       'Monday',
  'tuesday':   'Tuesday',
  'tue':       'Tuesday',
  'tues':      'Tuesday',
  'wednesday': 'Wednesday',
  'wed':       'Wednesday',
  'weds':      'Wednesday',
  'thursday':  'Thursday',
  'thu':       'Thursday',
  'thur':      'Thursday',
  'thurs':     'Thursday',
  'friday':    'Friday',
  'fri':       'Friday',
  'saturday':  'Saturday',
  'sat':       'Saturday',
  'sunday':    'Sunday',
  'sun':       'Sunday'
};

/**
 * Attempts to resolve a cell value to a canonical day name.
 * Returns the canonical name (e.g. "Monday") or null if not a day.
 */
function resolveDay(cellValue) {
  if (!cellValue) return null;
  const key = String(cellValue).trim().toLowerCase();
  return DAY_ALIASES[key] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT B: New LPU layout parser
// Cell format: "Lecture / G:All C:PES390 / R: 34-213\n / S:K3E0054"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts KEY:VALUE pairs from a cell text using segment-based tokenisation.
 *
 * The cell text is split on ' / ' separators.  Within each segment, field tags
 * (single uppercase letter followed by colon, e.g. G: C: R: S: F:) are located
 * and their values are extracted up to the next tag or the end of the segment.
 *
 * Parenthetical notes such as "( Makeup Class )" are stripped from values.
 *
 * @param {string} text – raw cell text (may contain \n characters)
 * @returns {{ G?: string, C?: string, R?: string, S?: string, F?: string }}
 */
function extractCellFields(text) {
  // Normalise newlines and collapse runs of whitespace
  const t = text.replace(/\n\s*/g, ' ').trim();
  const result = {};

  // Split on slash separators (the Excel format uses ' / ' between fields)
  const segments = t.split(/\s*\/\s*/);

  for (const seg of segments) {
    // Find all 'X:' tag positions within this segment (X = one of G C R S F)
    // The tag must be at the start of the segment or preceded by whitespace
    const tagRe = /(?:^|\s)([GCRSF]):/g;
    const tagPositions = [];
    let m;
    while ((m = tagRe.exec(seg)) !== null) {
      // Index of the letter character (not the preceding space)
      const tagStart = m.index + m[0].length - 2; // position of 'X:'
      tagPositions.push({ key: m[1], valueStart: tagStart + 2 });
    }

    for (let i = 0; i < tagPositions.length; i++) {
      const { key, valueStart } = tagPositions[i];
      // Value ends just before the next tag's ' X' prefix, or at segment end
      const valueEnd = i + 1 < tagPositions.length
        ? tagPositions[i + 1].valueStart - 2  // -2 to exclude the space + letter
        : seg.length;

      let value = seg.slice(valueStart, valueEnd)
        .replace(/\s*\([^)]*\)\s*/g, '')  // strip parenthetical notes
        .trim();

      result[key] = value;
    }
  }

  return result;
}

/**
 * Returns true if cell text matches the new LPU format (Format B).
 * Heuristic: starts with Lecture / Tutorial / Practical after optional whitespace,
 * or contains ' G:' or ' C:' field tags.
 */
function isNewFormat(text) {
  if (!text) return false;
  const t = text.replace(/\n\s*/g, ' ').trim();
  return /^(Lecture|Tutorial|Practical)/i.test(t) || /\b[GCR]:[^\s]/.test(t);
}

/**
 * Parse a Format B cell entry.
 *
 * @param {string} text          – raw cell text
 * @param {string|null} timing   – pre-parsed timing string "HH:MM - HH:MM"
 *                                 sourced from the separate timing column
 * @returns {object|null}        – parsed class object or null if not a class
 */
function parseNewFormatEntry(text, timing) {
  const t = text.replace(/\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Must start with a class type keyword
  const typeMatch = t.match(/^(Lecture|Tutorial|Practical)/i);
  if (!typeMatch) return null;

  const rawType = typeMatch[1].toLowerCase();
  const classType = rawType.charAt(0).toUpperCase() + rawType.slice(1); // e.g. "Lecture"
  const typeCode  = CLASS_TYPE_CODE[rawType] || rawType[0].toUpperCase();

  const isMakeup = /makeup\s*class/i.test(t);

  const fields = extractCellFields(t);
  const group      = fields.G || '';
  const courseCode = fields.C || '';
  const room       = fields.R || '';
  const section    = fields.S || '';
  const faculty    = fields.F || '';

  if (!courseCode) return null; // no course code → skip

  // Timing must be provided externally from the timing column
  if (!timing) return null;
  const { startTime, endTime } = timing;

  // Build a human-readable batch label (group + section info)
  let batch = group;
  if (section && section !== group) batch = batch ? `${batch} / ${section}` : section;

  return {
    startTime,
    endTime,
    slotKey: `${startTime} - ${endTime}`,
    room,
    type:      typeCode,
    typeLabel: classType,
    subject:   courseCode,
    batch,
    isMakeup,
    status: 'busy'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT A: Old LPU layout parser
// Cell format: "10:20 - 11:10:\n36-809 -  L -  PES319 323MB"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse raw cell text from old-format LPU Excel timetable.
 * The cell itself contains the timing on line 1 and class details on line 2.
 * Returns null if cell is empty, should be skipped, or cannot be parsed.
 */
function parseOldFormatCell(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;

  const timeLine   = lines[0];
  const detailLine = lines[1];

  const timeMatch = timeLine.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  if (!timeMatch) return null;

  const startTime = timeMatch[1];
  const endTime   = timeMatch[2];

  const parts = detailLine.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  const room           = parts[0];
  const type           = parts[1];
  const subjectAndBatch = parts[2];

  const subParts = subjectAndBatch.trim().split(/\s+/);
  const subject  = subParts[0] || '';
  const batch    = subParts[1] || '';

  if (subject.startsWith('CSES00')) return null;

  return {
    startTime,
    endTime,
    slotKey:   `${startTime} - ${endTime}`,
    room,
    type,
    typeLabel: TYPE_MAP[type] || type,
    subject,
    batch,
    isMakeup:  false,
    status:    'busy'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing column helpers (Format B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a timing string such as:
 *   "09:30-10:20 AM"  "12:50-01:40 PM"  "11:10-12:00 AM"  "14:30 - 15:20"
 * and returns { startTime: "HH:MM", endTime: "HH:MM" } in 24-hour format,
 * or null if the string cannot be parsed.
 *
 * AM/PM handling notes:
 *  - The suffix applies to the whole range (e.g. "11:10-12:00 AM" means
 *    start=11:10, end=12:00; both in the AM period).
 *  - "12:xx AM" is midnight (0:xx) and "12:xx PM" is noon (12:xx) per strict
 *    12-hour rules, but timetable context resolves ambiguity: if the computed
 *    endTime ends up earlier than startTime, we add 12 hours to endTime so
 *    the slot is always a forward interval (e.g. 11:10→12:00 stays 11:10→12:00).
 */
function parseTiming(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;

  let sh = parseInt(m[1], 10);
  const sm = m[2];
  let eh = parseInt(m[3], 10);
  const em  = m[4];
  const per = (m[5] || '').toUpperCase();

  // Convert start hour to 24-hour
  if (per === 'PM' && sh !== 12) sh += 12;
  if (per === 'AM' && sh === 12) sh = 0;

  // Convert end hour to 24-hour
  if (per === 'PM' && eh !== 12) eh += 12;
  if (per === 'AM' && eh === 12) eh = 0;

  // If end < start (e.g. "11:10-12:00 AM" after strict conversion gives
  // end=0:00 which is before 11:10), restore the intuitive slot boundary
  // by treating the end as 12:00 (noon) rather than midnight.
  if (eh < sh) eh += 12;

  const startTime = sh.toString().padStart(2, '0') + ':' + sm;
  const endTime   = eh.toString().padStart(2, '0') + ':' + em;
  return { startTime, endTime };
}

/**
 * Finds the column index used for timing information.
 * Scans rows from (headerRowIdx + 1) looking for cells that match a time range
 * pattern (HH:MM-HH:MM).  Returns the column index or -1 if not found.
 */
function findTimingColumn(rows, headerRowIdx) {
  const timeRe = /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/;
  // Look at up to 10 data rows
  const limit = Math.min(headerRowIdx + 11, rows.length);
  for (let ri = headerRowIdx + 1; ri < limit; ri++) {
    const row = rows[ri];
    if (!row) continue;
    for (let ci = 0; ci < row.length; ci++) {
      const val = row[ci];
      if (val && timeRe.test(String(val))) return ci;
    }
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merged-cell expansion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expands SheetJS merged-cell ranges into the rows array in-place.
 * sheet_to_json leaves only the top-left cell of a merged range populated;
 * all other cells in the range are null.  This function fills those nulls
 * with the top-left cell's value so downstream code can read any cell.
 *
 * Only fills null/undefined cells — existing values are never overwritten.
 */
function expandMergedCells(sheet, rows) {
  const merges = sheet['!merges'] || [];
  for (const { s, e } of merges) {
    const topLeftValue = rows[s.r]?.[s.c];
    if (topLeftValue == null) continue; // nothing to propagate

    for (let r = s.r; r <= e.r; r++) {
      if (!rows[r]) rows[r] = [];
      for (let c = s.c; c <= e.c; c++) {
        if (r === s.r && c === s.c) continue; // skip the source cell
        if (rows[r][c] == null || rows[r][c] === '') {
          rows[r][c] = topLeftValue;
        }
      }
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header-row detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans the first `maxScanRows` rows of a worksheet for a row containing
 * weekday headers. Returns { headerRowIdx, dayColumns } on success, or null.
 *
 * dayColumns: { "Monday": colIndex, "Tuesday": colIndex, ... }
 *
 * A row is considered a header row when it contains at least 2 distinct
 * canonical day names (guards against accidental matches in title/name rows).
 */
function findHeaderRow(rows, maxScanRows = 10) {
  const limit = Math.min(maxScanRows, rows.length);

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;

    const dayColumns = {};
    row.forEach((cell, colIdx) => {
      const day = resolveDay(cell);
      if (day && !(day in dayColumns)) {
        dayColumns[day] = colIdx;
      }
    });

    if (Object.keys(dayColumns).length >= 2) {
      return { headerRowIdx: i, dayColumns };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student ID extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans all rows before the header row for a cell containing a student ID
 * (7–12 consecutive digits).  Falls back to any non-empty cell text.
 */
function extractStudentId(rows, headerRowIdx) {
  for (let i = 0; i < headerRowIdx; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const cell of row) {
      if (!cell) continue;
      const match = String(cell).match(/(\d{7,12})/);
      if (match) return match[1];
    }
  }
  // Secondary pass: return any non-empty cell value that could be an ID
  for (let i = 0; i < headerRowIdx; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const cell of row) {
      if (cell) return String(cell).trim();
    }
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main parser.  Takes a File object (.xlsx / .xls), returns:
 * {
 *   studentId: "12345678",
 *   classes:  [ { day, startTime, endTime, room, type, typeLabel, subject, batch, isMakeup }, ... ],
 *   schedule: { Monday: { "10:20 - 11:10": { status, subject, room, type, typeLabel, batch, startTime, endTime } }, ... }
 * }
 */
export function parseLpuExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data     = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array', cellText: true, cellDates: false });

        const sheetName = workbook.SheetNames[0];
        const sheet     = workbook.Sheets[sheetName];

        // Convert to array-of-arrays (formatted strings, nulls for empty cells)
        let rows = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw:    false,  // get formatted text strings
          defval: null
        });

        if (rows.length < 2) {
          throw new Error(
            'This Excel file has too few rows to be a timetable. ' +
            'Please upload a valid LPU timetable spreadsheet.'
          );
        }

        // ── STEP 1: Expand merged cells ──────────────────────────────────────
        // sheet_to_json leaves null for all cells except the top-left of each
        // merged range.  We fill those nulls so the header scan and data reads
        // work correctly regardless of merged-cell layout.
        expandMergedCells(sheet, rows);

        // ── STEP 2: Auto-detect the weekday header row ───────────────────────
        // Scans the first 10 rows (after merge expansion) for a row that
        // contains at least 2 distinct day names.
        const headerResult = findHeaderRow(rows, 10);

        if (!headerResult) {
          const preview = rows.slice(0, 6).map((row, i) => {
            if (!row) return `  Row ${i + 1}: (empty)`;
            const cells = row.filter(Boolean).map(c => String(c).trim()).slice(0, 4);
            return `  Row ${i + 1}: ${cells.join(' | ') || '(empty)'}`;
          }).join('\n');

          throw new Error(
            'Could not find weekday headers (Monday, Tuesday, etc.) in the first 10 rows of this file.\n' +
            'UniSync supports full day names (Monday) and abbreviations (Mon, MON, Tue, TUE).\n\n' +
            'First rows found:\n' + preview + '\n\n' +
            'Please verify this is an LPU timetable Excel file and try again.'
          );
        }

        const { headerRowIdx, dayColumns } = headerResult;

        // ── STEP 3: Detect layout format ─────────────────────────────────────
        // Format B uses a separate timing column; Format A embeds timing in
        // each class cell.  We detect by looking for time-range values in a
        // non-day column of the data rows.
        const timingColIdx = findTimingColumn(rows, headerRowIdx);
        const isFormatB    = timingColIdx >= 0;

        // ── STEP 4: Extract student ID ───────────────────────────────────────
        const studentId = extractStudentId(rows, headerRowIdx);

        // ── STEP 5: Parse class data ─────────────────────────────────────────
        const classes  = [];
        const schedule = {};
        const seen     = new Set(); // deduplication key: day+startTime+subject

        // Initialise schedule for all detected days
        Object.keys(dayColumns).forEach(day => { schedule[day] = {}; });

        let lastTiming = null; // for Format B: carry timing across null timing cells

        for (let rowIdx = headerRowIdx + 1; rowIdx < rows.length; rowIdx++) {
          const row = rows[rowIdx];
          if (!row) continue;

          // ── Format B: read timing from the dedicated timing column ──
          if (isFormatB) {
            const rawTiming = row[timingColIdx];
            if (rawTiming) {
              const parsed = parseTiming(String(rawTiming));
              if (parsed) lastTiming = parsed;
            }
          }

          for (const [day, colIdx] of Object.entries(dayColumns)) {
            const cellValue = row[colIdx];
            if (!cellValue || String(cellValue).trim() === '') continue;

            const cellText = String(cellValue);

            // Collect one or more parsed entries from this cell.
            // Format B cells can contain multiple class entries separated by
            // ', Lecture' / ', Tutorial' / ', Practical' (comma + space + type).
            const parsedEntries = [];

            if (isFormatB && isNewFormat(cellText)) {
              // Split on ", <ClassType>" boundaries to handle multi-entry cells
              // e.g. "Practical / G:0 ... , Practical / G:1 ... (Makeup Class)"
              const entryTexts = cellText.split(/,\s*(?=(?:Lecture|Tutorial|Practical))/i);
              for (const entryText of entryTexts) {
                const p = parseNewFormatEntry(entryText, lastTiming);
                if (p) parsedEntries.push(p);
              }
            } else if (!isFormatB) {
              // Format A: timing is embedded in the cell
              const p = parseOldFormatCell(cellText);
              if (p) parsedEntries.push(p);
            }

            for (const parsed of parsedEntries) {
              // Deduplicate: same day + start time + course code + batch
              // (handles merged-cell expansion producing identical entries)
              const dedupKey = `${day}|${parsed.startTime}|${parsed.subject}|${parsed.batch}`;
              if (seen.has(dedupKey)) continue;
              seen.add(dedupKey);

              classes.push({
                day,
                startTime: parsed.startTime,
                endTime:   parsed.endTime,
                room:      parsed.room,
                type:      parsed.type,
                typeLabel: parsed.typeLabel,
                subject:   parsed.subject,
                batch:     parsed.batch,
                isMakeup:  parsed.isMakeup || false
              });

              // For the schedule, use a composite key when multiple entries
              // share the same time slot (e.g. different batch groups)
              let slotKey = parsed.slotKey;
              if (schedule[day][slotKey]) {
                // Slot already occupied → append batch suffix to key
                slotKey = `${parsed.slotKey}|${parsed.batch}`;
              }
              schedule[day][slotKey] = {
                status:    'busy',
                subject:   parsed.subject,
                room:      parsed.room,
                type:      parsed.type,
                typeLabel: parsed.typeLabel,
                batch:     parsed.batch,
                startTime: parsed.startTime,
                endTime:   parsed.endTime,
                isMakeup:  parsed.isMakeup || false
              };
            }
          }
        }

        // ── STEP 6: Sort classes by day order then by start time ─────────────
        classes.sort((a, b) => {
          const dA = DAY_ORDER.indexOf(a.day);
          const dB = DAY_ORDER.indexOf(b.day);
          if (dA !== dB) return dA - dB;
          return a.startTime.localeCompare(b.startTime);
        });

        resolve({ studentId, classes, schedule });
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read the uploaded file. Please try again.'));
    reader.readAsArrayBuffer(file);
  });
}
