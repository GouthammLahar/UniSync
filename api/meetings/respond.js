/**
 * api/meetings/respond.js — Vercel Serverless: Respond to meeting invitation
 *
 * Supports two flows:
 * 1. Website flow (POST, Authorization: Bearer <FirebaseIdToken>):
 *    Body: { meetingId, response: 'accepted'|'rejected' } -> returns JSON
 * 2. Email one-click flow:
 *    - GET  ?token=<rawToken> : Read-only validation & renders HTML confirmation form
 *    - POST { token }         : Atomically consumes token in Firestore transaction,
 *                               updates meeting, dispatches notifications, returns HTML
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';
import { sendGmailMeetingResponse, sendGmailMeetingConfirmed, hashActionToken } from '../_utils/gmail.js';
import { formatEmailDate, formatEmailTime12 } from '../_utils/email.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://unisynclive.vercel.app';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderActionPage({
  title,
  badgeText,
  badgeBg = '#DDEDFE',
  badgeColor = '#0356E3',
  headline,
  bodyHtml,
  formToken = null,
  formLabel = null,
  formBtnColor = '#0356E3',
  ctaUrl = `${APP_URL}/#meetings`,
  ctaText = 'Open UniSync Meetings'
}) {
  const formSection = formToken
    ? `
      <form method="POST" action="/api/meetings/respond" style="margin:24px 0 16px 0;">
        <input type="hidden" name="token" value="${escapeHtml(formToken)}" />
        <button type="submit" style="display:inline-block;background-color:${escapeHtml(formBtnColor)};color:#FFFFFF;font-size:15px;font-weight:700;border:none;padding:14px 28px;border-radius:10px;cursor:pointer;font-family:inherit;">
          ${escapeHtml(formLabel)}
        </button>
      </form>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — UniSync</title>
</head>
<body style="margin:0;padding:24px 16px;background-color:#F8FAFC;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F172A;">
  <div style="max-width:520px;margin:40px auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(3,30,91,0.06);">
    <div style="background-color:#031E5B;padding:24px 28px;text-align:center;">
      <img src="${APP_URL}/brand/01-primary-logo-transparent.png" alt="UniSync" width="130" style="display:block;margin:0 auto;max-width:130px;height:auto;" />
    </div>
    <div style="padding:28px;text-align:center;">
      <span style="display:inline-block;background-color:${escapeHtml(badgeBg)};color:${escapeHtml(badgeColor)};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;padding:6px 12px;border-radius:999px;margin-bottom:14px;">
        ${escapeHtml(badgeText)}
      </span>
      <h1 style="margin:0 0 12px 0;font-size:21px;font-weight:700;color:#031E5B;line-height:1.3;">
        ${escapeHtml(headline)}
      </h1>
      <div style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#475569;">
        ${bodyHtml}
      </div>
      ${formSection}
      <div style="margin-top:16px;">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;color:#0356E3;font-size:14px;font-weight:600;text-decoration:none;">
          ${escapeHtml(ctaText)} →
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(statusCode).send(html);
}

/**
 * Shared notification & email dispatcher.
 * Called ONLY after Firestore meeting state has been committed.
 */
async function dispatchMeetingResponseNotifications(db, meeting, meetingId, uid, responderName, response, statusTransitionToConfirmed) {
  const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
  const notifType = response === 'accepted' ? 'meeting_accepted' : 'meeting_rejected';

  const existingOrgNotif = await db.collection('notifications')
    .where('recipientId', '==', meeting.organizerUid)
    .where('meetingId', '==', meetingId)
    .where('senderId', '==', uid)
    .where('type', '==', notifType)
    .limit(1)
    .get();

  if (existingOrgNotif.empty) {
    await db.collection('notifications').add({
      recipientId: meeting.organizerUid,
      senderId: uid,
      type: notifType,
      title: `${responderName} ${response === 'accepted' ? 'accepted' : 'declined'} "${meeting.title}"`,
      message: `Response for meeting on ${meeting.date}`,
      meetingId,
      read: false,
      createdAt: FieldValue.serverTimestamp()
    });
  }

  try {
    await sendGmailMeetingResponse(meeting, meetingId, uid, response);
  } catch (emailErr) {
    console.error('[api/meetings/respond] Organizer email dispatch error:', emailErr);
  }

  if (statusTransitionToConfirmed) {
    for (const pid of meeting.participants) {
      if (pid !== uid) {
        const existingConfNotif = await db.collection('notifications')
          .where('recipientId', '==', pid)
          .where('meetingId', '==', meetingId)
          .where('type', '==', 'meeting_confirmed')
          .limit(1)
          .get();

        if (existingConfNotif.empty) {
          await db.collection('notifications').add({
            recipientId: pid,
            senderId: uid,
            type: 'meeting_confirmed',
            title: `"${meeting.title}" is confirmed!`,
            message: `All participants accepted. Meeting on ${meeting.date} at ${meeting.startTime}.`,
            meetingId,
            read: false,
            createdAt: FieldValue.serverTimestamp()
          });
        }
      }
    }

    const tokens = await getTokensForUsers(meeting.participants.filter(p => p !== uid));
    if (tokens.length > 0) {
      await sendFCMToTokens(tokens,
        { title: `🎉 Meeting Confirmed: ${meeting.title}`, body: `See you on ${meeting.date} at ${meeting.startTime}!` },
        { type: 'meeting_confirmed', meetingId }
      );
    }

    try {
      await sendGmailMeetingConfirmed(meeting, meetingId);
    } catch (emailErr) {
      console.error('[api/meetings/respond] Confirmed email dispatch error:', emailErr);
    }
  }
}

function validateTokenRecord(tokenData, meeting) {
  if (!tokenData) {
    return { valid: false, status: 404, title: 'Invalid Link', badge: 'Invalid Token', headline: 'This response link is invalid', message: 'The link may be malformed or no longer exists.' };
  }
  if (tokenData.used) {
    return { valid: false, status: 410, title: 'Link Already Used', badge: 'Already Responded', headline: 'This response link has already been used', message: 'You have already submitted a response using this invitation.' };
  }
  const expiresAtMs = tokenData.expiresAt?.toMillis ? tokenData.expiresAt.toMillis() : new Date(tokenData.expiresAt).getTime();
  if (!expiresAtMs || Date.now() > expiresAtMs) {
    return { valid: false, status: 410, title: 'Link Expired', badge: 'Expired', headline: 'This response link has expired', message: 'Please open UniSync directly to respond to this meeting.' };
  }
  if (!meeting) {
    return { valid: false, status: 404, title: 'Meeting Not Found', badge: 'Not Found', headline: 'Meeting not found', message: 'This meeting may have been deleted.' };
  }
  if (meeting.status === 'cancelled') {
    return { valid: false, status: 410, title: 'Meeting Cancelled', badge: 'Cancelled', headline: 'This meeting was cancelled', message: `<strong>"${escapeHtml(meeting.title)}"</strong> has been cancelled by the organizer.` };
  }
  if (!Array.isArray(meeting.participants) || !meeting.participants.includes(tokenData.uid)) {
    return { valid: false, status: 403, title: 'Access Denied', badge: 'Unauthorized', headline: 'You are not a participant', message: 'Your account is not listed as a participant for this meeting.' };
  }
  return { valid: true };
}

/**
 * GET /api/meetings/respond?token=<rawToken>
 * Read-only: never mutates state or consumes tokens.
 */
async function handleGetConfirmation(req, res) {
  const rawToken = req.query?.token;
  if (!rawToken || typeof rawToken !== 'string') {
    return sendHtml(res, 400, renderActionPage({
      title: 'Missing Token',
      badgeText: 'Invalid Request',
      badgeBg: '#FEE2E2',
      badgeColor: '#B91C1C',
      headline: 'Missing response token',
      bodyHtml: 'Please use the Accept or Decline button from your UniSync invitation email.'
    }));
  }

  try {
    const db = getAdminFirestore();
    const tokenHash = hashActionToken(rawToken);
    const tokenSnap = await db.collection('meetingActionTokens').doc(tokenHash).get();
    const tokenData = tokenSnap.exists ? tokenSnap.data() : null;

    let meeting = null;
    if (tokenData?.meetingId) {
      const meetingSnap = await db.doc(`meetings/${tokenData.meetingId}`).get();
      meeting = meetingSnap.exists ? meetingSnap.data() : null;
    }

    const check = validateTokenRecord(tokenData, meeting);
    if (!check.valid) {
      return sendHtml(res, check.status, renderActionPage({
        title: check.title,
        badgeText: check.badge,
        badgeBg: '#FEE2E2',
        badgeColor: '#B91C1C',
        headline: check.headline,
        bodyHtml: check.message,
        ctaUrl: tokenData?.meetingId ? `${APP_URL}/?meetingId=${encodeURIComponent(tokenData.meetingId)}#meetings` : `${APP_URL}/#meetings`
      }));
    }

    const isAccept = tokenData.action === 'accepted';
    const safeTitle = escapeHtml(meeting.title);
    const safeDate = escapeHtml(formatEmailDate(meeting.date));
    const safeTime = escapeHtml(formatEmailTime12(meeting.startTime));

    return sendHtml(res, 200, renderActionPage({
      title: isAccept ? 'Confirm Accept' : 'Confirm Decline',
      badgeText: isAccept ? 'Confirm Acceptance' : 'Confirm Decline',
      badgeBg: isAccept ? '#DCFCE7' : '#FEE2E2',
      badgeColor: isAccept ? '#15803D' : '#B91C1C',
      headline: `${isAccept ? 'Accept' : 'Decline'} "${safeTitle}"?`,
      bodyHtml: `Scheduled for <strong>${safeDate}</strong> at <strong>${safeTime}</strong>.<br/>Click below to confirm your response.`,
      formToken: rawToken,
      formLabel: isAccept ? 'Confirm Accept' : 'Confirm Decline',
      formBtnColor: isAccept ? '#15803D' : '#DC2626',
      ctaUrl: `${APP_URL}/?meetingId=${encodeURIComponent(tokenData.meetingId)}#meetings`,
      ctaText: 'View Meeting in UniSync'
    }));
  } catch (err) {
    console.error('[api/meetings/respond] GET error:', err);
    return sendHtml(res, 500, renderActionPage({
      title: 'Server Error',
      badgeText: 'Error',
      badgeBg: '#FEE2E2',
      badgeColor: '#B91C1C',
      headline: 'Something went wrong',
      bodyHtml: 'Unable to load this meeting response. Please try again in UniSync.'
    }));
  }
}

/**
 * POST /api/meetings/respond with { token }
 * Atomically consumes token + sibling token in a Firestore transaction.
 */
async function handleTokenPostResponse(req, res, rawToken) {
  try {
    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const tokenHash = hashActionToken(rawToken);
    const tokenRef = db.collection('meetingActionTokens').doc(tokenHash);

    const txResult = await db.runTransaction(async (tx) => {
      const tokenSnap = await tx.get(tokenRef);
      const tokenData = tokenSnap.exists ? tokenSnap.data() : null;

      let meetingSnap = null;
      let meetingRef = null;
      if (tokenData?.meetingId) {
        meetingRef = db.doc(`meetings/${tokenData.meetingId}`);
        meetingSnap = await tx.get(meetingRef);
      }
      const meeting = meetingSnap?.exists ? meetingSnap.data() : null;

      const check = validateTokenRecord(tokenData, meeting);
      if (!check.valid) {
        return { ok: false, check, meetingId: tokenData?.meetingId || null };
      }

      const uid = tokenData.uid;
      const response = tokenData.action;
      const updatedResponses = { ...meeting.responses, [uid]: response };
      const allAccepted = meeting.participants.every(p => updatedResponses[p] === 'accepted');
      const newStatus = allAccepted ? 'confirmed' : meeting.status;
      const statusTransitionToConfirmed = allAccepted && meeting.status !== 'confirmed';

      tx.update(tokenRef, {
        used: true,
        usedAt: FieldValue.serverTimestamp()
      });

      if (tokenData.siblingHash) {
        const siblingRef = db.collection('meetingActionTokens').doc(tokenData.siblingHash);
        tx.update(siblingRef, {
          used: true,
          invalidatedBySibling: true,
          usedAt: FieldValue.serverTimestamp()
        });
      }

      tx.update(meetingRef, {
        [`responses.${uid}`]: response,
        status: newStatus,
        updatedAt: FieldValue.serverTimestamp()
      });

      return {
        ok: true,
        meeting,
        meetingId: tokenData.meetingId,
        uid,
        response,
        statusTransitionToConfirmed
      };
    });

    if (!txResult.ok) {
      const { check, meetingId } = txResult;
      return sendHtml(res, check.status, renderActionPage({
        title: check.title,
        badgeText: check.badge,
        badgeBg: '#FEE2E2',
        badgeColor: '#B91C1C',
        headline: check.headline,
        bodyHtml: check.message,
        ctaUrl: meetingId ? `${APP_URL}/?meetingId=${encodeURIComponent(meetingId)}#meetings` : `${APP_URL}/#meetings`
      }));
    }

    const { meeting, meetingId, uid, response, statusTransitionToConfirmed } = txResult;
    const responderName = meeting.participantNames?.[uid] || 'A participant';

    // Dispatch notifications ONLY after transaction commit
    await dispatchMeetingResponseNotifications(db, meeting, meetingId, uid, responderName, response, statusTransitionToConfirmed);

    const isAccept = response === 'accepted';
    return sendHtml(res, 200, renderActionPage({
      title: isAccept ? 'Meeting Accepted' : 'Meeting Declined',
      badgeText: isAccept ? 'Accepted' : 'Declined',
      badgeBg: isAccept ? '#DCFCE7' : '#FEE2E2',
      badgeColor: isAccept ? '#15803D' : '#B91C1C',
      headline: `You ${isAccept ? 'accepted' : 'declined'} "${escapeHtml(meeting.title)}"`,
      bodyHtml: `Your response has been recorded for <strong>${escapeHtml(formatEmailDate(meeting.date))}</strong> at <strong>${escapeHtml(formatEmailTime12(meeting.startTime))}</strong>.`,
      ctaUrl: `${APP_URL}/?meetingId=${encodeURIComponent(meetingId)}#meetings`,
      ctaText: 'View Meeting in UniSync'
    }));
  } catch (err) {
    console.error('[api/meetings/respond] Token POST error:', err);
    return sendHtml(res, 500, renderActionPage({
      title: 'Server Error',
      badgeText: 'Error',
      badgeBg: '#FEE2E2',
      badgeColor: '#B91C1C',
      headline: 'Could not record your response',
      bodyHtml: 'Please try again or respond directly in UniSync.'
    }));
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGetConfirmation(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Email one-click form/JSON token flow
  if (req.body?.token && !req.headers.authorization) {
    return handleTokenPostResponse(req, res, String(req.body.token));
  }

  // Existing authenticated website flow
  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingId, response } = req.body || {};

    if (!meetingId || !['accepted', 'rejected'].includes(response)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const meetingRef = db.doc(`meetings/${meetingId}`);
    const snap = await meetingRef.get();

    if (!snap.exists) return res.status(404).json({ error: 'Meeting not found' });
    const meeting = snap.data();
    if (!meeting.participants.includes(uid)) return res.status(403).json({ error: 'Not a participant' });

    const updatedResponses = { ...meeting.responses, [uid]: response };
    const allAccepted = meeting.participants.every(p => updatedResponses[p] === 'accepted');
    const newStatus = allAccepted ? 'confirmed' : meeting.status;
    const statusTransitionToConfirmed = allAccepted && meeting.status !== 'confirmed';

    await meetingRef.update({
      [`responses.${uid}`]: response,
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp()
    });

    const participantNames = meeting.participantNames || {};
    const myName = participantNames[uid] || decoded.name || 'A participant';

    await dispatchMeetingResponseNotifications(db, meeting, meetingId, uid, myName, response, statusTransitionToConfirmed);

    return res.status(200).json({ success: true, allAccepted, newStatus });
  } catch (err) {
    console.error('respond meeting error:', err);
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
