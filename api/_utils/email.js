/**
 * api/_utils/email.js — UniSync Meeting Email Notification Service
 * Exclusively for meeting-related events: invitations, confirmations,
 * cancellations, responses, and upcoming reminders.
 *
 * Features:
 * - Direct REST API integration with Resend (zero external dependencies)
 * - Firebase Admin Auth integration to securely retrieve verified user emails
 * - Event-specific idempotency keys in Firestore (`meetingEmails`) to prevent duplicates
 * - Production-ready, responsive, brand-accurate HTML email templates
 * - Non-blocking execution: email failures NEVER interrupt meeting lifecycle
 */

import { getAuth } from 'firebase-admin/auth';
import { getAdminApp, getAdminFirestore } from './admin.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://unisynclive.vercel.app';
const LOGO_URL = `${APP_URL}/brand/01-primary-logo-transparent.png`;
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || 'UniSync Meetings <notifications@unisync.app>';

/**
 * Format date string "YYYY-MM-DD" to human readable "Friday, 28 Nov 2026"
 */
export function formatEmailDate(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return dateStr;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format 24h time "14:30" to 12h "2:30 PM"
 */
export function formatEmailTime12(time24) {
  if (!time24) return '';
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  if (isNaN(h)) return time24;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

/**
 * Batch retrieves verified emails & display names for Firebase UIDs via Admin Auth.
 * @param {string[]} uids
 * @returns {Promise<Object>} Map of { [uid]: { email: string, name: string } }
 */
export async function getUserEmails(uids) {
  if (!uids || !Array.isArray(uids) || uids.length === 0) return {};
  
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  const userMap = {};

  try {
    getAdminApp();
    const auth = getAuth();
    
    // Admin SDK allows querying up to 100 users per batch
    const batches = [];
    while (uniqueUids.length > 0) {
      const chunk = uniqueUids.splice(0, 100);
      batches.push(auth.getUsers(chunk.map(uid => ({ uid }))));
    }

    const results = await Promise.all(batches);
    results.forEach(res => {
      res.users.forEach(u => {
        if (u.email) {
          userMap[u.uid] = {
            email: u.email,
            name: u.displayName || u.email.split('@')[0] || 'UniSync Member'
          };
        }
      });
    });
  } catch (err) {
    console.error('[Email Service] Failed to retrieve user emails from Admin Auth:', err.message);
  }

  return userMap;
}

/**
 * Checks Firestore delivery record to prevent duplicate emails for identical event.
 * @param {string} idempotencyKey
 * @returns {Promise<boolean>} true if already sent
 */
export async function isEmailAlreadySent(idempotencyKey) {
  if (!idempotencyKey) return false;
  try {
    const db = getAdminFirestore();
    const docRef = db.doc(`meetingEmails/${idempotencyKey}`);
    const snap = await docRef.get();
    return snap.exists;
  } catch (err) {
    console.warn('[Email Service] Idempotency check error:', err.message);
    return false;
  }
}

/**
 * Records that an email was sent in Firestore for audit & idempotency.
 */
export async function recordEmailSent(idempotencyKey, data) {
  if (!idempotencyKey) return;
  try {
    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    await db.doc(`meetingEmails/${idempotencyKey}`).set({
      ...data,
      sentAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('[Email Service] Failed to record email idempotency:', err.message);
  }
}

/**
 * Low-level Resend REST API email sender.
 * If RESEND_API_KEY is not set, safely logs a warning and skips without throwing.
 */
export async function sendEmailViaResend({ to, subject, html, idempotencyKey = null, metadata = {} }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn('[Email Service] RESEND_API_KEY not configured. Skipping email to:', to, `("${subject}")`);
    return { success: false, reason: 'NO_API_KEY' };
  }

  if (idempotencyKey && await isEmailAlreadySent(idempotencyKey)) {
    console.log('[Email Service] Skipping duplicate email for key:', idempotencyKey);
    return { success: true, skippedDuplicate: true };
  }

  try {
    const fromAddress = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });

    const resData = await response.json();

    if (!response.ok) {
      console.error('[Email Service] Resend API error:', resData);
      return { success: false, error: resData };
    }

    if (idempotencyKey) {
      await recordEmailSent(idempotencyKey, {
        to,
        subject,
        resendId: resData.id,
        ...metadata
      });
    }

    console.log('[Email Service] Email sent successfully to:', to, `Resend ID: ${resData.id}`);
    return { success: true, id: resData.id };
  } catch (err) {
    console.error('[Email Service] Unexpected error sending email via Resend:', err.message);
    return { success: false, error: err.message };
  }
}

/* =========================================================
   RESPONSIVE BRAND EMAIL TEMPLATES
========================================================= */

export function baseEmailTemplate({ badgeText, badgeBg, badgeColor, headline, bodyContent, meetingCardHtml, ctaText, ctaUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body, table, td, p, a, li, blockquote { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; background-color: #F8FAFC; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0F172A;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8FAFC; padding: 32px 16px;">
    <tr>
      <td align="center">
        <!-- Main Container Card -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; background-color: #FFFFFF; border: 1px solid #E0E8F5; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 18px rgba(3, 30, 91, 0.05);">
          
          <!-- Brand Header Bar -->
          <tr>
            <td style="padding: 24px 32px; background-color: #FFFFFF; border-bottom: 1px solid #E0E8F5; text-align: left;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left">
                    <a href="${APP_URL}" target="_blank" style="text-decoration: none; display: inline-block;">
                      <img src="${LOGO_URL}" alt="UniSync" height="32" style="height: 32px; display: block; border: 0;" />
                    </a>
                  </td>
                  <td align="right">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 9999px; background-color: ${badgeBg}; color: ${badgeColor}; display: inline-block;">
                      ${badgeText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; text-align: left;">
              <h1 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 800; color: #031E5B; line-height: 1.35; letter-spacing: -0.01em;">
                ${headline}
              </h1>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #475569;">
                ${bodyContent}
              </p>

              <!-- Meeting Details Card -->
              ${meetingCardHtml}

              <!-- Call to Action Button -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 28px;">
                <tr>
                  <td align="center">
                    <a href="${ctaUrl}" target="_blank" style="display: inline-block; background-color: #0356E3; color: #FFFFFF; font-size: 14px; font-weight: 700; text-decoration: none; padding: 13px 30px; border-radius: 9999px; box-shadow: 0 2px 8px rgba(3, 86, 227, 0.28); text-align: center; mso-padding-alt: 0;">
                      <!--[if mso]>
                      <i style="letter-spacing: 30px; mso-font-width: -100%; mso-text-raise: 20pt;">&nbsp;</i>
                      <![endif]-->
                      <span style="mso-text-raise: 10pt;">${ctaText}</span>
                      <!--[if mso]>
                      <i style="letter-spacing: 30px; mso-font-width: -100%;">&nbsp;</i>
                      <![endif]-->
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer Information -->
          <tr>
            <td style="padding: 20px 32px; background-color: #F8FAFC; border-top: 1px solid #E0E8F5; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; color: #64748B; line-height: 1.5;">
                UniSync — Connect • Coordinate • Together<br>Smart Campus Timetable &amp; Meeting Coordination
              </p>
              <p style="margin: 0; font-size: 11px; color: #94A3B8;">
                This automated notification was sent for an active meeting in your campus circle.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderMeetingCard(meeting) {
  const dateFormatted = formatEmailDate(meeting.date);
  const timeFormatted = `${formatEmailTime12(meeting.startTime)} – ${formatEmailTime12(meeting.endTime)}`;
  const duration = meeting.durationMins ? `${meeting.durationMins} minutes` : '60 minutes';
  const location = meeting.location || 'Location details in app';
  const organizer = meeting.organizerName || 'Squad Member';
  const squad = meeting.groupName ? meeting.groupName : null;

  return `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8FAFC; border: 1px solid #E0E8F5; border-radius: 10px; padding: 18px; margin: 0 0 4px 0;">
    <tr>
      <td style="padding-bottom: 12px; border-bottom: 1px solid #E2E8F0;">
        <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748B; letter-spacing: 0.05em; display: block; margin-bottom: 2px;">Title</span>
        <strong style="font-size: 16px; color: #031E5B; display: block; font-weight: 700;">${meeting.title}</strong>
      </td>
    </tr>
    <tr>
      <td style="padding: 12px 0 0 0;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td width="50%" valign="top" style="padding-bottom: 10px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">📅 Date</span>
              <span style="font-size: 13px; font-weight: 600; color: #0F172A;">${dateFormatted}</span>
            </td>
            <td width="50%" valign="top" style="padding-bottom: 10px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">⏰ Time</span>
              <span style="font-size: 13px; font-weight: 600; color: #0F172A;">${timeFormatted}</span>
            </td>
          </tr>
          <tr>
            <td width="50%" valign="top" style="padding-bottom: 10px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">📍 Location</span>
              <span style="font-size: 13px; font-weight: 600; color: #0F172A;">${location}</span>
            </td>
            <td width="50%" valign="top" style="padding-bottom: 10px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">👤 Organizer</span>
              <span style="font-size: 13px; font-weight: 600; color: #0F172A;">${organizer}</span>
            </td>
          </tr>
          ${squad ? `
          <tr>
            <td colspan="2" valign="top" style="padding-top: 4px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">👥 Squad</span>
              <span style="font-size: 13px; font-weight: 600; color: #0356E3;">${squad}</span>
            </td>
          </tr>` : ''}
          ${meeting.notes ? `
          <tr>
            <td colspan="2" valign="top" style="padding-top: 8px;">
              <span style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; display: block;">📝 Notes</span>
              <span style="font-size: 12px; color: #475569; line-height: 1.4; display: block;">${meeting.notes}</span>
            </td>
          </tr>` : ''}
        </table>
      </td>
    </tr>
  </table>`;
}

/* =========================================================
   HIGH-LEVEL MEETING EVENT DISPATCHERS
========================================================= */

/**
 * Event 1: Meeting Invitation (sent to all participants except organizer)
 */
export async function sendMeetingInviteEmails(meeting, meetingId) {
  const participants = (meeting.participants || []).filter(uid => uid !== meeting.organizerUid);
  if (participants.length === 0) return;

  const users = await getUserEmails(participants);
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;

  for (const uid of participants) {
    const user = users[uid];
    if (!user?.email) continue;

    const idempotencyKey = `invite_${meetingId}_${uid}`;
    const meetingCard = renderMeetingCard(meeting);

    const html = baseEmailTemplate({
      badgeText: 'Meeting Invite',
      badgeBg: '#DDEDFE',
      badgeColor: '#031E5B',
      headline: `${meeting.organizerName || 'A squad member'} invited you to a meeting`,
      bodyContent: `You have been invited to <strong>"${meeting.title}"</strong>. Check the scheduled details below and respond with your availability in UniSync.`,
      meetingCardHtml: meetingCard,
      ctaText: 'View & Respond in UniSync',
      ctaUrl
    });

    await sendEmailViaResend({
      to: user.email,
      subject: `📅 Meeting Invitation: "${meeting.title}" (${formatEmailDate(meeting.date)})`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'invite', uid }
    });
  }
}

/**
 * Event 2: Participant Accepted or Rejected (sent to organizer)
 */
export async function sendMeetingResponseEmail(meeting, meetingId, respondentUid, response) {
  if (respondentUid === meeting.organizerUid) return; // Organizer doesn't notify self

  const users = await getUserEmails([meeting.organizerUid, respondentUid]);
  const organizer = users[meeting.organizerUid];
  const respondent = users[respondentUid] || { name: (meeting.participantNames || {})[respondentUid] || 'A participant' };

  if (!organizer?.email) return;

  const isAccepted = response === 'accepted';
  const idempotencyKey = `response_${meetingId}_${respondentUid}_${response}`;
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;
  const meetingCard = renderMeetingCard(meeting);

  const html = baseEmailTemplate({
    badgeText: isAccepted ? 'Invitation Accepted' : 'Invitation Declined',
    badgeBg: isAccepted ? '#DCFCE7' : '#FEE2E2',
    badgeColor: isAccepted ? '#15803D' : '#B91C1C',
    headline: `${respondent.name} ${isAccepted ? 'accepted' : 'declined'} your meeting invitation`,
    bodyContent: `${respondent.name} has submitted their response for <strong>"${meeting.title}"</strong> scheduled for ${formatEmailDate(meeting.date)}.`,
    meetingCardHtml: meetingCard,
    ctaText: 'View Meeting in UniSync',
    ctaUrl
  });

  await sendEmailViaResend({
    to: organizer.email,
    subject: `${isAccepted ? '✅ Accepted' : '❌ Declined'}: ${respondent.name} responded to "${meeting.title}"`,
    html,
    idempotencyKey,
    metadata: { meetingId, eventType: 'response', respondentUid, response }
  });
}

/**
 * Event 3: All Participants Accepted -> Meeting Confirmed (sent to all participants)
 */
export async function sendMeetingConfirmedEmails(meeting, meetingId) {
  const participants = meeting.participants || [];
  if (participants.length === 0) return;

  const users = await getUserEmails(participants);
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;

  for (const uid of participants) {
    const user = users[uid];
    if (!user?.email) continue;

    const idempotencyKey = `confirmed_${meetingId}_${uid}`;
    const meetingCard = renderMeetingCard(meeting);

    const html = baseEmailTemplate({
      badgeText: 'Confirmed',
      badgeBg: '#DCFCE7',
      badgeColor: '#15803D',
      headline: `All participants accepted! "${meeting.title}" is confirmed.`,
      bodyContent: `Great news! Everyone accepted the meeting invite. The meeting has been confirmed for <strong>${formatEmailDate(meeting.date)}</strong> at <strong>${formatEmailTime12(meeting.startTime)}</strong>.`,
      meetingCardHtml: meetingCard,
      ctaText: 'View Confirmed Meeting',
      ctaUrl
    });

    await sendEmailViaResend({
      to: user.email,
      subject: `🎉 Meeting Confirmed: "${meeting.title}" on ${formatEmailDate(meeting.date)}`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'confirmed', uid }
    });
  }
}

/**
 * Event 4: Meeting Cancelled by Organizer (sent to all participants except organizer)
 */
export async function sendMeetingCancelledEmails(meeting, meetingId) {
  const participants = (meeting.participants || []).filter(uid => uid !== meeting.organizerUid);
  if (participants.length === 0) return;

  const users = await getUserEmails(participants);
  const ctaUrl = `${APP_URL}/#meetings`;

  for (const uid of participants) {
    const user = users[uid];
    if (!user?.email) continue;

    const idempotencyKey = `cancelled_${meetingId}_${uid}`;
    const meetingCard = renderMeetingCard(meeting);

    const html = baseEmailTemplate({
      badgeText: 'Cancelled',
      badgeBg: '#FEE2E2',
      badgeColor: '#B91C1C',
      headline: `Meeting Cancelled: "${meeting.title}"`,
      bodyContent: `The meeting scheduled for ${formatEmailDate(meeting.date)} at ${formatEmailTime12(meeting.startTime)} has been cancelled by the organizer (${meeting.organizerName || 'Organizer'}).`,
      meetingCardHtml: meetingCard,
      ctaText: 'Go to UniSync Meetings',
      ctaUrl
    });

    await sendEmailViaResend({
      to: user.email,
      subject: `❌ Meeting Cancelled: "${meeting.title}"`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'cancelled', uid }
    });
  }
}

/**
 * Event 5: Meeting Reminder (sent to all confirmed participants before start)
 */
export async function sendMeetingReminderEmails(meeting, meetingId, windowMins) {
  const participants = meeting.participants || [];
  if (participants.length === 0) return;

  const users = await getUserEmails(participants);
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;

  for (const uid of participants) {
    const user = users[uid];
    if (!user?.email) continue;

    const idempotencyKey = `reminder_${meetingId}_${windowMins}m_${uid}`;
    const meetingCard = renderMeetingCard(meeting);

    const html = baseEmailTemplate({
      badgeText: `Starts in ${windowMins}m`,
      badgeBg: '#FEF3C7',
      badgeColor: '#B45309',
      headline: `Reminder: "${meeting.title}" starts in ${windowMins} minutes`,
      bodyContent: `Your meeting is scheduled to begin shortly at <strong>${formatEmailTime12(meeting.startTime)}</strong> (${formatEmailDate(meeting.date)}). Location: <strong>${meeting.location || 'See UniSync'}</strong>.`,
      meetingCardHtml: meetingCard,
      ctaText: 'Open Meeting Details',
      ctaUrl
    });

    await sendEmailViaResend({
      to: user.email,
      subject: `⏰ Reminder: "${meeting.title}" begins in ${windowMins} minutes`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'reminder', windowMins, uid }
    });
  }
}
