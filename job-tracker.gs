/**
 * Job Application Auto-Logger — v3
 * Scans Gmail for application activity and maintains a Google Sheet pipeline.
 *
 * CHANGES FROM V2:
 *   - 90-day backfill function added
 *   - Stale apps (30+ days, no response) auto-flip to "Ghosted" status
 *   - Two view tabs (Active, Closed) auto-created with QUERY formulas
 *
 * SETUP:
 *   1. Paste your Sheet ID below (already set)
 *   2. Run setupSheet() once
 *   3. Run backfillApplications() to pull last 90 days
 *   4. Re-run backfillApplications() if it logs "Time budget hit"
 *   5. Set daily/weekly triggers (instructions at bottom)
 */

// ====== CONFIG ======
const SHEET_ID = 'YOUR_SHEET_ID_HERE';
const SHEET_NAME = 'Applications';
const ACTIVE_SHEET_NAME = 'Active';
const CLOSED_SHEET_NAME = 'Closed';
const PROCESSED_LABEL = 'JobTracker/Logged';
const INTERVIEW_LABEL = 'JobTracker/Interview';
const REJECTED_LABEL = 'JobTracker/Rejected';

const APPLICATION_KEYWORDS = [
  'thank you for applying',
  'thanks for applying',
  'application received',
  'we received your application',
  'your application to',
  'application confirmation',
  'application submitted',
  'we have received your application',
  'thank you for your interest',
  'your application has been received'
];

const INTERVIEW_KEYWORDS = [
  'schedule an interview',
  'schedule a call',
  'phone screen',
  'phone interview',
  'next steps',
  'would like to interview',
  'invitation to interview',
  'interview with',
  'set up a time',
  'set up a call',
  'available for a call',
  'available for an interview',
  'moving forward in our process',
  'move forward in the process',
  'technical interview',
  'recruiter screen',
  'hiring manager'
];

const REJECTION_KEYWORDS = [
  'unfortunately',
  'we will not be moving forward',
  'not moving forward',
  'moving forward with other candidates',
  'decided to move forward with other',
  'pursue other candidates',
  'other applicants',
  'we have decided not to',
  'unable to offer',
  'will not be progressing',
  'position has been filled',
  'role has been filled',
  'pursuing other candidates',
  'wish you the best in your',
  'we regret to inform'
];

const LOOKBACK_DAYS = 2;
const STATUS_LOOKBACK_DAYS = 14;
const STALE_DAYS = 14;          // notes a follow-up reminder
const GHOSTED_DAYS = 30;        // flips status to "Ghosted"
const BACKFILL_DAYS = 90;
const SUMMARY_RECIPIENT = '';
// =====================


// ====== COLUMN MAP ======
const COL = {
  DATE_APPLIED: 1,
  COMPANY: 2,
  ROLE: 3,
  STATUS: 4,
  SUBJECT: 5,
  SENDER: 6,
  THREAD_LINK: 7,
  LOGGED_AT: 8,
  LAST_UPDATE: 9,
  NOTES: 10
};
const HEADER = [
  'Date Applied', 'Company', 'Role', 'Status',
  'Email Subject', 'Sender', 'Gmail Thread Link',
  'Logged At', 'Last Update', 'Notes'
];
// =========================


/**
 * Run once. Safe to re-run — idempotent.
 */
function setupSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // --- Applications tab ---
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, HEADER.length);
  } else {
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    HEADER.forEach((name, i) => {
      if (existing[i] !== name) {
        sheet.getRange(1, i + 1).setValue(name).setFontWeight('bold');
      }
    });
  }

  // --- Active view tab ---
  let activeSheet = ss.getSheetByName(ACTIVE_SHEET_NAME);
  if (!activeSheet) activeSheet = ss.insertSheet(ACTIVE_SHEET_NAME);
  activeSheet.clear();
  activeSheet.getRange('A1').setFormula(
    `=QUERY(Applications!A:J, "SELECT A,B,C,D,I,J WHERE D='Applied' OR D='Interview' ORDER BY I DESC", 1)`
  );
  activeSheet.setFrozenRows(1);

  // --- Closed view tab ---
  let closedSheet = ss.getSheetByName(CLOSED_SHEET_NAME);
  if (!closedSheet) closedSheet = ss.insertSheet(CLOSED_SHEET_NAME);
  closedSheet.clear();
  closedSheet.getRange('A1').setFormula(
    `=QUERY(Applications!A:J, "SELECT A,B,C,D,J WHERE D='Rejected' OR D='Ghosted' ORDER BY A DESC", 1)`
  );
  closedSheet.setFrozenRows(1);

  ensureLabel_(PROCESSED_LABEL);
  ensureLabel_(INTERVIEW_LABEL);
  ensureLabel_(REJECTED_LABEL);
  Logger.log('Setup complete (v3).');
}


/**
 * Daily: log new applications.
 */
function logJobApplications() {
  const sheet = getSheet_();
  const label = ensureLabel_(PROCESSED_LABEL);
  const existingThreadIds = getExistingThreadIds_(sheet);

  const subjectQuery = APPLICATION_KEYWORDS.map(k => `subject:"${k}"`).join(' OR ');
  const query = `(${subjectQuery}) newer_than:${LOOKBACK_DAYS}d -label:${PROCESSED_LABEL}`;

  const threads = GmailApp.search(query, 0, 100);
  Logger.log(`[apply] ${threads.length} candidate threads.`);

  let added = 0;
  threads.forEach(thread => {
    const threadId = thread.getId();
    if (existingThreadIds.has(threadId)) {
      thread.addLabel(label);
      return;
    }

    const msg = thread.getMessages()[0];
    const subject = msg.getSubject() || '';
    const from = msg.getFrom() || '';
    const date = msg.getDate();

    const company = extractCompany_(from, subject);
    const role = extractRole_(subject, msg.getPlainBody());
    const threadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

    const row = new Array(HEADER.length).fill('');
    row[COL.DATE_APPLIED - 1] = date;
    row[COL.COMPANY - 1] = company;
    row[COL.ROLE - 1] = role;
    row[COL.STATUS - 1] = 'Applied';
    row[COL.SUBJECT - 1] = subject;
    row[COL.SENDER - 1] = from;
    row[COL.THREAD_LINK - 1] = threadLink;
    row[COL.LOGGED_AT - 1] = new Date();
    row[COL.LAST_UPDATE - 1] = new Date();

    sheet.appendRow(row);
    thread.addLabel(label);
    added++;
  });

  Logger.log(`[apply] Added ${added} new application(s).`);
}


/**
 * One-time 90-day backfill. Idempotent — re-run if it times out.
 */
function backfillApplications() {
  const sheet = getSheet_();
  const label = ensureLabel_(PROCESSED_LABEL);
  const existingThreadIds = getExistingThreadIds_(sheet);

  const subjectQuery = APPLICATION_KEYWORDS.map(k => `subject:"${k}"`).join(' OR ');
  const query = `(${subjectQuery}) newer_than:${BACKFILL_DAYS}d -label:${PROCESSED_LABEL}`;

  const threads = GmailApp.search(query, 0, 500);
  Logger.log(`[backfill] ${threads.length} candidate threads.`);

  const startMs = Date.now();
  const TIMEOUT_BUDGET_MS = 4 * 60 * 1000;

  let added = 0;
  let skipped = 0;
  for (let i = 0; i < threads.length; i++) {
    if (Date.now() - startMs > TIMEOUT_BUDGET_MS) {
      Logger.log(`[backfill] Time budget hit at ${i}/${threads.length}. Re-run to continue.`);
      break;
    }

    const thread = threads[i];
    const threadId = thread.getId();
    if (existingThreadIds.has(threadId)) {
      thread.addLabel(label);
      skipped++;
      continue;
    }

    const msg = thread.getMessages()[0];
    const subject = msg.getSubject() || '';
    const from = msg.getFrom() || '';
    const date = msg.getDate();

    const company = extractCompany_(from, subject);
    const role = extractRole_(subject, msg.getPlainBody());
    const threadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

    const row = new Array(HEADER.length).fill('');
    row[COL.DATE_APPLIED - 1] = date;
    row[COL.COMPANY - 1] = company;
    row[COL.ROLE - 1] = role;
    row[COL.STATUS - 1] = 'Applied';
    row[COL.SUBJECT - 1] = subject;
    row[COL.SENDER - 1] = from;
    row[COL.THREAD_LINK - 1] = threadLink;
    row[COL.LOGGED_AT - 1] = new Date();
    row[COL.LAST_UPDATE - 1] = new Date();
    row[COL.NOTES - 1] = 'BACKFILL';

    sheet.appendRow(row);
    thread.addLabel(label);
    added++;
  }

  Logger.log(`[backfill] Added ${added}, skipped ${skipped} already-logged.`);
}


/**
 * Daily: detect interview emails.
 */
function updateInterviewStatus() {
  updateStatusByKeywords_({
    keywords: INTERVIEW_KEYWORDS,
    newStatus: 'Interview',
    label: INTERVIEW_LABEL,
    skipIfStatusIn: ['Offer', 'Accepted', 'Rejected', 'Withdrawn'],
    logTag: 'interview'
  });
}


/**
 * Daily: detect rejection emails.
 */
function updateRejectionStatus() {
  updateStatusByKeywords_({
    keywords: REJECTION_KEYWORDS,
    newStatus: 'Rejected',
    label: REJECTED_LABEL,
    skipIfStatusIn: ['Accepted', 'Withdrawn'],
    logTag: 'reject',
    matchBody: true
  });
}


/**
 * Daily: flag stale (14d) and auto-ghost (30d).
 */
function flagStaleApplications() {
  const sheet = getSheet_();
  if (sheet.getLastRow() < 2) return;

  const lastRow = sheet.getLastRow();
  const range = sheet.getRange(2, 1, lastRow - 1, HEADER.length);
  const values = range.getValues();
  const now = new Date();

  let flagged = 0;
  let ghosted = 0;
  values.forEach((row, i) => {
    const status = (row[COL.STATUS - 1] || '').toString();
    const dateApplied = row[COL.DATE_APPLIED - 1];
    const notes = (row[COL.NOTES - 1] || '').toString();
    if (status !== 'Applied') return;
    if (!(dateApplied instanceof Date)) return;

    const ageDays = Math.floor((now - dateApplied) / 86400000);

    // Auto-ghost at 30 days
    if (ageDays >= GHOSTED_DAYS) {
      sheet.getRange(i + 2, COL.STATUS).setValue('Ghosted');
      sheet.getRange(i + 2, COL.LAST_UPDATE).setValue(now);
      const note = notes
        ? `${notes} | GHOSTED (${ageDays}d, no response)`
        : `GHOSTED (${ageDays}d, no response)`;
      sheet.getRange(i + 2, COL.NOTES).setValue(note);
      ghosted++;
      return;
    }

    // Stale follow-up reminder at 14 days
    if (ageDays >= STALE_DAYS && !notes.includes('STALE')) {
      const note = notes
        ? `${notes} | STALE (${ageDays}d, follow up)`
        : `STALE (${ageDays}d, follow up)`;
      sheet.getRange(i + 2, COL.NOTES).setValue(note);
      sheet.getRange(i + 2, COL.LAST_UPDATE).setValue(now);
      flagged++;
    }
  });

  Logger.log(`[stale] Flagged ${flagged} stale, ghosted ${ghosted}.`);
}


/**
 * Weekly (Sunday): email a digest.
 */
function sendWeeklySummary() {
  const sheet = getSheet_();
  if (sheet.getLastRow() < 2) {
    Logger.log('[summary] No data yet.');
    return;
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADER.length).getValues();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  let appliedThisWeek = 0;
  let interviewsThisWeek = 0;
  let rejectionsThisWeek = 0;
  const statusCounts = {};
  const stale = [];

  data.forEach(row => {
    const dateApplied = row[COL.DATE_APPLIED - 1];
    const lastUpdate = row[COL.LAST_UPDATE - 1];
    const status = (row[COL.STATUS - 1] || 'Unknown').toString();
    const company = (row[COL.COMPANY - 1] || '').toString();
    const role = (row[COL.ROLE - 1] || '').toString();
    const notes = (row[COL.NOTES - 1] || '').toString();

    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (dateApplied instanceof Date && dateApplied >= weekAgo) appliedThisWeek++;
    if (lastUpdate instanceof Date && lastUpdate >= weekAgo) {
      if (status === 'Interview') interviewsThisWeek++;
      if (status === 'Rejected') rejectionsThisWeek++;
    }
    if (notes.includes('STALE')) stale.push({ company, role });
  });

  const tz = Session.getScriptTimeZone();
  const dateStr = Utilities.formatDate(now, tz, 'MMM d, yyyy');

  let html = `<div style="font-family:-apple-system,sans-serif;max-width:600px">`;
  html += `<h2 style="color:#1a73e8;margin-bottom:4px">Job Search — Week of ${dateStr}</h2>`;
  html += `<h3>This week</h3><ul>`;
  html += `<li><b>${appliedThisWeek}</b> new application${appliedThisWeek === 1 ? '' : 's'}</li>`;
  html += `<li><b>${interviewsThisWeek}</b> moved to interview</li>`;
  html += `<li><b>${rejectionsThisWeek}</b> rejection${rejectionsThisWeek === 1 ? '' : 's'}</li>`;
  html += `</ul>`;

  html += `<h3>Pipeline (all time)</h3><ul>`;
  Object.keys(statusCounts).sort().forEach(s => {
    html += `<li>${s}: <b>${statusCounts[s]}</b></li>`;
  });
  html += `</ul>`;

  if (stale.length) {
    html += `<h3 style="color:#d93025">Stale — needs follow-up (${stale.length})</h3><ul>`;
    stale.slice(0, 15).forEach(s => {
      html += `<li>${escapeHtml_(s.company)} — ${escapeHtml_(s.role || '(role unknown)')}</li>`;
    });
    if (stale.length > 15) html += `<li>...and ${stale.length - 15} more</li>`;
    html += `</ul>`;
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  html += `<p><a href="${sheetUrl}">Open the tracker →</a></p></div>`;

  const recipient = SUMMARY_RECIPIENT || Session.getActiveUser().getEmail();
  GmailApp.sendEmail(recipient, `Job Search Summary — ${dateStr}`, '', {
    htmlBody: html,
    name: 'Job Tracker'
  });
  Logger.log(`[summary] Sent to ${recipient}.`);
}


// ====== INTERNAL HELPERS ======

function updateStatusByKeywords_(opts) {
  const { keywords, newStatus, label, skipIfStatusIn, logTag, matchBody } = opts;
  const sheet = getSheet_();
  if (sheet.getLastRow() < 2) return;

  const gmailLabel = ensureLabel_(label);

  const queryParts = matchBody
    ? keywords.map(k => `"${k}"`)
    : keywords.map(k => `subject:"${k}"`);
  const query = `(${queryParts.join(' OR ')}) newer_than:${STATUS_LOOKBACK_DAYS}d -label:${label}`;

  const threads = GmailApp.search(query, 0, 100);
  Logger.log(`[${logTag}] ${threads.length} candidate threads.`);

  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(2, 1, lastRow - 1, HEADER.length).getValues();
  const byCompany = {};
  data.forEach((row, i) => {
    const c = (row[COL.COMPANY - 1] || '').toString().toLowerCase().trim();
    if (!c) return;
    if (!byCompany[c]) byCompany[c] = [];
    byCompany[c].push({ rowIndex: i + 2, status: row[COL.STATUS - 1] });
  });

  let updated = 0;
  threads.forEach(thread => {
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    const from = msg.getFrom() || '';
    const subject = msg.getSubject() || '';
    const company = extractCompany_(from, subject).toLowerCase().trim();

    const candidates = byCompany[company];
    if (!candidates || candidates.length === 0) {
      Logger.log(`[${logTag}] No matching row for company "${company}" (subject: ${subject})`);
      return;
    }

    const target = candidates
      .filter(c => !skipIfStatusIn.includes((c.status || '').toString()))
      .sort((a, b) => b.rowIndex - a.rowIndex)[0];
    if (!target) return;

    sheet.getRange(target.rowIndex, COL.STATUS).setValue(newStatus);
    sheet.getRange(target.rowIndex, COL.LAST_UPDATE).setValue(new Date());

    const noteCell = sheet.getRange(target.rowIndex, COL.NOTES);
    const existing = (noteCell.getValue() || '').toString();
    const stamp = `${newStatus} email: ${truncate_(subject, 60)}`;
    noteCell.setValue(existing ? `${existing} | ${stamp}` : stamp);

    thread.addLabel(gmailLabel);
    updated++;
  });

  Logger.log(`[${logTag}] Updated ${updated} row(s) to "${newStatus}".`);
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureLabel_(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

function getExistingThreadIds_(sheet) {
  const ids = new Set();
  if (sheet.getLastRow() < 2) return ids;
  const links = sheet.getRange(2, COL.THREAD_LINK, sheet.getLastRow() - 1, 1).getValues();
  links.forEach(row => {
    const link = row[0];
    if (typeof link === 'string') {
      const m = link.match(/#inbox\/([a-zA-Z0-9]+)/);
      if (m) ids.add(m[1]);
    }
  });
  return ids;
}

function extractCompany_(from, subject) {
  const nameMatch = from.match(/^"?([^"<]+?)"?\s*</);
  if (nameMatch) {
    let name = nameMatch[1].trim();
    name = name.replace(/\s+(careers|recruiting|talent|hr|jobs|team)$/i, '');
    if (name && !/no[-\s]?reply/i.test(name)) return name;
  }
  const atMatch = subject.match(/\bat\s+([A-Z][\w&.\-' ]{1,40})/);
  if (atMatch) return atMatch[1].trim();
  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    const domain = domainMatch[1].split('.').slice(-2, -1)[0] || domainMatch[1];
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return 'Unknown';
}

function extractRole_(subject, body) {
  const patterns = [
    /(?:applying|application)\s+(?:for|to)(?:\s+the)?\s+(.+?)(?:\s+(?:position|role|at|with|-|\u2013)|$)/i,
    /position[: ]+(.+?)(?:\s+(?:at|with|-|\u2013)|$)/i,
    /role[: ]+(.+?)(?:\s+(?:at|with|-|\u2013)|$)/i,
    /^(.+?)\s+[-\u2013]\s+application/i
  ];
  for (const re of patterns) {
    const m = subject.match(re);
    if (m && m[1]) {
      const role = m[1].trim().replace(/[.!?]+$/, '');
      if (role.length > 2 && role.length < 80) return role;
    }
  }
  return '';
}

function truncate_(s, n) {
  s = (s || '').toString();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml_(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


/**
 * SCHEDULING — set as triggers in Apps Script editor:
 *
 *   logJobApplications     Day timer    6am–7am
 *   updateInterviewStatus  Day timer    7am–8am
 *   updateRejectionStatus  Day timer    7am–8am
 *   flagStaleApplications  Day timer    8am–9am
 *   sendWeeklySummary      Week timer   Sunday 7pm–8pm
 */
