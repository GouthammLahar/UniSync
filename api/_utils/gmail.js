/**
 * api/_utils/gmail.js — UniSync Gmail OAuth & Message Delivery Utility
 * Exclusively uses https://www.googleapis.com/auth/gmail.send
 * Securely manages user-specific OAuth2 tokens in server-side Firestore.
 */

import crypto from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { getAdminApp, getAdminFirestore } from './admin.js';
import { isEmailAlreadySent, recordEmailSent, getUserEmails, formatEmailDate, formatEmailTime12, baseEmailTemplate, renderMeetingCard } from './email.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://unisynclive.vercel.app';

export function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('localhost') ? 'http' : 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'unisynclive.vercel.app';
  return `${proto}://${host}/api/auth/gmail/callback`;
}

/**
 * Generate a cryptographically signed state token embedding the Firebase UID and timestamp
 */
export function createSignedState(uid) {
  const secret = process.env.GOOGLE_CLIENT_SECRET || process.env.CRON_SECRET || 'unisync-oauth-secret-fallback-key';
  const timestamp = Date.now();
  const payload = `${uid}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

/**
 * Verify signed state token and extract Firebase UID (valid for 15 minutes)
 */
export function verifySignedState(stateStr) {
  if (!stateStr) return null;
  try {
    const decoded = Buffer.from(stateStr, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [uid, timestampStr, hmac] = parts;
    const timestamp = parseInt(timestampStr, 10);
    
    // Check 15-minute expiration
    if (Date.now() - timestamp > 15 * 60 * 1000) return null;

    const secret = process.env.GOOGLE_CLIENT_SECRET || process.env.CRON_SECRET || 'unisync-oauth-secret-fallback-key';
    const expected = crypto.createHmac('sha256', secret).update(`${uid}:${timestampStr}`).digest('hex');
    
    const hmacBuf = Buffer.from(hmac, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (hmacBuf.length === expectedBuf.length && crypto.timingSafeEqual(hmacBuf, expectedBuf)) {
      return uid;
    }
  } catch (err) {
    console.warn('[Gmail OAuth] State verification error:', err.message);
  }
  return null;
}

/**
 * Checks whether a given user has connected Gmail and has active credentials.
 */
export async function getGmailConnectionStatus(uid) {
  if (!uid) return { connected: false };
  try {
    const db = getAdminFirestore();
    const docSnap = await db.collection('userCredentials').doc(uid).get();
    if (!docSnap.exists) return { connected: false };

    const data = docSnap.data();
    const gmail = data?.gmail;
    if (!gmail || !gmail.refreshToken || gmail.revoked) {
      return { connected: false };
    }

    return {
      connected: true,
      connectedAt: gmail.connectedAt ? (gmail.connectedAt.toDate ? gmail.connectedAt.toDate().toISOString() : gmail.connectedAt) : null,
      email: gmail.senderEmail || null
    };
  } catch (err) {
    console.error('[Gmail] Status lookup failed for uid:', uid, err.message);
    return { connected: false, error: err.message };
  }
}

/**
 * Retrieves or refreshes a valid access token for the specified user UID.
 * Returns null if user has not connected Gmail or if token is revoked.
 */
export async function getValidAccessToken(uid) {
  if (!uid) return null;
  try {
    const db = getAdminFirestore();
    const credRef = db.collection('userCredentials').doc(uid);
    const docSnap = await credRef.get();
    if (!docSnap.exists) return null;

    const data = docSnap.data();
    const gmail = data?.gmail;
    if (!gmail || !gmail.refreshToken || gmail.revoked) return null;

    // Check if current accessToken is still valid (with 60-second buffer)
    const now = Date.now();
    if (gmail.accessToken && gmail.expiryDate && now < (gmail.expiryDate - 60000)) {
      return gmail.accessToken;
    }

    // Refresh token using Google OAuth2 endpoint
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.warn('[Gmail] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing');
      return null;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: gmail.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.warn('[Gmail] Token refresh error for uid:', uid, tokenData);
      if (tokenData.error === 'invalid_grant') {
        // Mark token as revoked so we don't spam Google
        await credRef.update({ 'gmail.revoked': true });
      }
      return null;
    }

    const newAccessToken = tokenData.access_token;
    const newExpiry = now + (tokenData.expires_in * 1000);

    await credRef.update({
      'gmail.accessToken': newAccessToken,
      'gmail.expiryDate': newExpiry,
      'gmail.revoked': false
    });

    return newAccessToken;
  } catch (err) {
    console.error('[Gmail] Failed to get valid access token for uid:', uid, err.message);
    return null;
  }
}

/**
 * Builds RFC 2822 MIME message string.
 */
function buildMimeMessage({ fromName, fromEmail, toEmail, subject, html }) {
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
  const formattedFrom = fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail;

  return [
    `From: ${formattedFrom}`,
    `To: ${toEmail}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html
  ].join('\r\n');
}

/**
 * Sends an email using the Gmail REST API (users.messages.send) on behalf of senderUid.
 * Strictly requires the sender to have connected Gmail.
 */
export async function sendEmailViaGmail({ senderUid, to, subject, html, idempotencyKey = null, metadata = {} }) {
  if (!senderUid) {
    return { success: false, reason: 'NO_SENDER_UID' };
  }

  if (idempotencyKey && await isEmailAlreadySent(idempotencyKey)) {
    console.log('[Gmail] Skipping duplicate email for key:', idempotencyKey);
    return { success: true, skippedDuplicate: true };
  }

  const accessToken = await getValidAccessToken(senderUid);
  if (!accessToken) {
    // Organiser/sender has not connected Gmail or revoked access
    console.log('[Gmail] User', senderUid, 'has not connected Gmail. Skipping email to:', to);
    return { success: false, reason: 'GMAIL_NOT_CONNECTED' };
  }

  try {
    // Get sender profile details from Firebase Admin Auth
    getAdminApp();
    const auth = getAuth();
    const senderUser = await auth.getUser(senderUid).catch(() => null);
    const senderEmail = senderUser?.email || 'me';
    const senderName = senderUser?.displayName || 'UniSync User';

    const mime = buildMimeMessage({
      fromName: senderName,
      fromEmail: senderEmail,
      toEmail: to,
      subject,
      html
    });

    const base64UrlMessage = Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: base64UrlMessage })
    });

    const result = await res.json();
    if (!res.ok) {
      console.error('[Gmail API Error]:', res.status, result);
      return { success: false, error: result.error?.message || 'GMAIL_API_ERROR' };
    }

    if (idempotencyKey) {
      await recordEmailSent(idempotencyKey, {
        senderUid,
        senderEmail,
        recipientEmail: to,
        provider: 'gmail',
        gmailMessageId: result.id,
        ...metadata
      });
    }

    console.log(`[Gmail] Successfully sent email to ${to} (Message ID: ${result.id})`);
    return { success: true, messageId: result.id };
  } catch (err) {
    console.error('[Gmail] Send exception:', err.message);
    return { success: false, error: err.message };
  }
}

/* ===================================================================
   MEETING LIFECYCLE DISPATCHERS (Powered by Organizer/Sender's Gmail)
=================================================================== */

/**
 * 1. Meeting Created: Sent from Organiser's Gmail to Invited Participants
 */
export async function sendGmailMeetingInvites(meeting, meetingId) {
  const organizerUid = meeting.organizerUid;
  const participants = (meeting.participants || []).filter(uid => uid !== organizerUid);
  if (participants.length === 0) return;

  const users = await getUserEmails(participants);
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;

  for (const uid of participants) {
    const user = users[uid];
    if (!user?.email) continue;

    const idempotencyKey = `invite_${meetingId}_${uid}`;
    const meetingCard = renderMeetingCard(meeting);

    const html = baseEmailTemplate({
      badgeText: 'Meeting Invitation',
      badgeBg: '#DDEDFE',
      badgeColor: '#0356E3',
      headline: `${meeting.organizerName || 'A squad member'} invited you to a meeting`,
      bodyContent: `You have been invited to join <strong>"${meeting.title}"</strong> on <strong>${formatEmailDate(meeting.date)}</strong> at <strong>${formatEmailTime12(meeting.startTime)}</strong>. Please review and respond in UniSync.`,
      meetingCardHtml: meetingCard,
      ctaText: 'Accept or Decline Meeting',
      ctaUrl
    });

    await sendEmailViaGmail({
      senderUid: organizerUid,
      to: user.email,
      subject: `📅 Meeting Invitation: "${meeting.title}" on ${formatEmailDate(meeting.date)}`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'invite', uid }
    });
  }
}

/**
 * 2. Meeting Response: Sent from Responder's Gmail to Organiser
 */
export async function sendGmailMeetingResponse(meeting, meetingId, responderUid, response) {
  if (responderUid === meeting.organizerUid) return;

  const users = await getUserEmails([meeting.organizerUid, responderUid]);
  const organizer = users[meeting.organizerUid];
  const responder = users[responderUid];
  if (!organizer?.email) return;

  const responderName = responder?.name || meeting.participantNames?.[responderUid] || 'A participant';
  const isAccepted = response === 'accepted';
  const idempotencyKey = `response_${meetingId}_${responderUid}_${response}`;
  const meetingCard = renderMeetingCard(meeting);
  const ctaUrl = `${APP_URL}/?meetingId=${meetingId}#meetings`;

  const html = baseEmailTemplate({
    badgeText: isAccepted ? 'Invitation Accepted' : 'Invitation Declined',
    badgeBg: isAccepted ? '#DCFCE7' : '#FEE2E2',
    badgeColor: isAccepted ? '#15803D' : '#B91C1C',
    headline: `${responderName} has ${isAccepted ? 'accepted' : 'declined'} your meeting`,
    bodyContent: `${responderName} responded to your invitation for <strong>"${meeting.title}"</strong> scheduled on <strong>${formatEmailDate(meeting.date)}</strong> at <strong>${formatEmailTime12(meeting.startTime)}</strong>.`,
    meetingCardHtml: meetingCard,
    ctaText: 'View Meeting in UniSync',
    ctaUrl
  });

  await sendEmailViaGmail({
    senderUid: responderUid,
    to: organizer.email,
    subject: `${isAccepted ? '✅ Accepted' : '❌ Declined'}: "${meeting.title}" by ${responderName}`,
    html,
    idempotencyKey,
    metadata: { meetingId, eventType: 'response', response, responderUid }
  });
}

/**
 * 3. Meeting Confirmed: Sent from Organiser's Gmail to All Participants
 */
export async function sendGmailMeetingConfirmed(meeting, meetingId) {
  const organizerUid = meeting.organizerUid;
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

    await sendEmailViaGmail({
      senderUid: organizerUid,
      to: user.email,
      subject: `🎉 Meeting Confirmed: "${meeting.title}" on ${formatEmailDate(meeting.date)}`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'confirmed', uid }
    });
  }
}

/**
 * 4. Meeting Cancelled: Sent from Organiser's Gmail to Other Participants
 */
export async function sendGmailMeetingCancelled(meeting, meetingId) {
  const organizerUid = meeting.organizerUid;
  const participants = (meeting.participants || []).filter(uid => uid !== organizerUid);
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

    await sendEmailViaGmail({
      senderUid: organizerUid,
      to: user.email,
      subject: `❌ Meeting Cancelled: "${meeting.title}"`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'cancelled', uid }
    });
  }
}

/**
 * 5. Meeting Reminder: Sent from Organiser's Gmail to Participants
 */
export async function sendGmailMeetingReminder(meeting, meetingId, windowMins) {
  const organizerUid = meeting.organizerUid;
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

    await sendEmailViaGmail({
      senderUid: organizerUid,
      to: user.email,
      subject: `⏰ Reminder: "${meeting.title}" begins in ${windowMins} minutes`,
      html,
      idempotencyKey,
      metadata: { meetingId, eventType: 'reminder', windowMins, uid }
    });
  }
}
