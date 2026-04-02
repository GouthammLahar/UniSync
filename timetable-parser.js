/**
 * timetable-parser.js
 * Parses LPU timetable Excel (.xlsx) files using SheetJS.
 * Returns a schedule object keyed by day → slot string → class data.
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

/**
 * Parse raw cell text from LPU Excel timetable.
 * Format: "10:20 - 11:10:\n36-809 -  L -  PES319 323MB"
 * Returns null if cell is empty or should be skipped.
 */
function parseCellText(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;

  const timeLine = lines[0];
  const detailLine = lines[1];

  // Extract start and end times
  const timeMatch = timeLine.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  if (!timeMatch) return null;

  const startTime = timeMatch[1];
  const endTime = timeMatch[2];

  // Split details by ' - ' 
  const parts = detailLine.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  const room = parts[0];
  const type = parts[1];
  const subjectAndBatch = parts[2];

  // Split subject and batch by whitespace
  const subParts = subjectAndBatch.trim().split(/\s+/);
  const subject = subParts[0] || '';
  const batch = subParts[1] || '';

  // Skip assignment placeholder subjects
  if (subject.startsWith('CSES00')) return null;

  return {
    startTime,  // e.g. "10:20"
    endTime,    // e.g. "11:10"
    slotKey: `${startTime} - ${endTime}`,  // e.g. "10:20 - 11:10"
    room,
    type,
    typeLabel: TYPE_MAP[type] || type,
    subject,
    batch,
    status: 'busy'
  };
}

/**
 * Main parser. Takes a File object (.xlsx), returns:
 * {
 *   studentId: "12345678",
 *   classes: [ { day, startTime, endTime, room, type, subject, batch }, ... ],
 *   schedule: { Monday: { "10:20 - 11:10": { status, subject, room, type, batch, startTime, endTime } }, ... }
 * }
 */
export function parseLpuExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array', cellText: true, cellDates: false });

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Convert to array-of-arrays (raw values)
        const rows = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,       // get formatted text strings
          defval: null
        });

        if (rows.length < 3) {
          throw new Error('Excel file has too few rows. Is this an LPU timetable?');
        }

        // Row 1 (index 1): VID / Student ID
        // It's usually "VID : 12345678" or just the number
        let studentId = '';
        const row1 = rows[1];
        if (row1) {
          // Find first non-null cell that looks like a student id line
          for (const cell of row1) {
            if (cell) {
              const match = String(cell).match(/(\d{7,12})/);
              if (match) { studentId = match[1]; break; }
              studentId = String(cell).trim();
              break;
            }
          }
        }

        // Row 2 (index 2): Day headers — find column indices for each day
        const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const row2 = rows[2] || [];
        const dayColumns = {}; // dayName → colIndex

        row2.forEach((cell, colIdx) => {
          if (!cell) return;
          const val = String(cell).trim();
          if (dayOrder.includes(val)) {
            dayColumns[val] = colIdx;
          }
        });

        if (Object.keys(dayColumns).length === 0) {
          throw new Error('Could not find day headers (Monday, Tuesday…) in row 3. Please check the file.');
        }

        // Rows 3+ (index 3+): Class data
        const classes = [];
        const schedule = {};

        // Initialize schedule for all found days
        Object.keys(dayColumns).forEach(day => { schedule[day] = {}; });

        for (let rowIdx = 3; rowIdx < rows.length; rowIdx++) {
          const row = rows[rowIdx];
          if (!row) continue;

          for (const [day, colIdx] of Object.entries(dayColumns)) {
            const cellValue = row[colIdx];
            if (!cellValue) continue;

            const parsed = parseCellText(String(cellValue));
            if (!parsed) continue;

            classes.push({
              day,
              startTime: parsed.startTime,
              endTime: parsed.endTime,
              room: parsed.room,
              type: parsed.type,
              typeLabel: parsed.typeLabel,
              subject: parsed.subject,
              batch: parsed.batch
            });

            // Store in schedule under slot key
            schedule[day][parsed.slotKey] = {
              status: 'busy',
              subject: parsed.subject,
              room: parsed.room,
              type: parsed.type,
              typeLabel: parsed.typeLabel,
              batch: parsed.batch,
              startTime: parsed.startTime,
              endTime: parsed.endTime
            };
          }
        }

        // Sort classes by day order, then by startTime
        classes.sort((a, b) => {
          const dA = dayOrder.indexOf(a.day);
          const dB = dayOrder.indexOf(b.day);
          if (dA !== dB) return dA - dB;
          return a.startTime.localeCompare(b.startTime);
        });

        resolve({ studentId, classes, schedule });
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}
