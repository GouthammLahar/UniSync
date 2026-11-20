/**
 * api/assistant/_rate-limit.js
 * Atomic persistent rate limiting & quota control via Firestore transactions.
 * Guarantees that concurrent requests cannot exceed daily user or global limits.
 */

import { getNowInTimezone } from './_date.js';

export const USER_DAILY_LIMIT = parseInt(process.env.ASSISTANT_USER_DAILY_LIMIT || '3', 10);
export const GLOBAL_DAILY_LIMIT = parseInt(process.env.ASSISTANT_GLOBAL_DAILY_LIMIT || '300', 10);
export const COOLDOWN_MS = 10000; // 10 seconds between requests

/**
 * Pre-check ensuring cooldown, user limit, and global limit are satisfied
 * before dispatching external Gemini API requests. Does NOT consume quota.
 */
export async function checkRateLimitPrecondition(db, uid, tz) {
  const { dateStr } = getNowInTimezone(tz);
  const nowMs = Date.now();

  const globalRef = db.doc(`assistantUsage/global_${dateStr}`);
  const userRef = db.doc(`assistantUsage/user_${uid}_${dateStr}`);

  const [globalSnap, userSnap] = await Promise.all([
    globalRef.get(),
    userRef.get()
  ]);

  const globalData = globalSnap.exists ? globalSnap.data() : { count: 0 };
  const userData = userSnap.exists ? userSnap.data() : { count: 0, lastRequestAt: 0 };

  const globalCount = typeof globalData.count === 'number' ? globalData.count : 0;
  const userCount = typeof userData.count === 'number' ? userData.count : 0;
  const lastRequestAt = typeof userData.lastRequestAt === 'number' ? userData.lastRequestAt : 0;

  // 1. Cooldown check
  const elapsed = nowMs - lastRequestAt;
  if (elapsed < COOLDOWN_MS) {
    const waitSecs = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    const err = new Error(`Please wait ${waitSecs}s before sending another question.`);
    err.code = 'COOLDOWN_ACTIVE';
    err.waitSecs = waitSecs;
    throw err;
  }

  // 2. User daily limit check
  if (userCount >= USER_DAILY_LIMIT) {
    const err = new Error(`You have reached your daily allowance of ${USER_DAILY_LIMIT} assistant queries for today. Your allowance resets at midnight.`);
    err.code = 'USER_LIMIT_REACHED';
    err.limit = USER_DAILY_LIMIT;
    throw err;
  }

  // 3. Global daily safety limit check
  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    const err = new Error('The campus assistant has reached its maximum daily usage capacity. Please check back tomorrow.');
    err.code = 'GLOBAL_LIMIT_REACHED';
    err.limit = GLOBAL_DAILY_LIMIT;
    throw err;
  }

  return { allowed: true };
}

/**
 * Checks and atomically increments rate limit counters inside a Firestore transaction.
 * Throws structured errors if any limit is breached.
 */
export async function consumeRateLimit(db, uid, tz) {
  const { dateStr } = getNowInTimezone(tz);
  const nowMs = Date.now();

  const globalRef = db.doc(`assistantUsage/global_${dateStr}`);
  const userRef = db.doc(`assistantUsage/user_${uid}_${dateStr}`);

  return db.runTransaction(async (transaction) => {
    const [globalSnap, userSnap] = await Promise.all([
      transaction.get(globalRef),
      transaction.get(userRef)
    ]);

    const globalData = globalSnap.exists ? globalSnap.data() : { count: 0 };
    const userData = userSnap.exists ? userSnap.data() : { count: 0, lastRequestAt: 0 };

    const globalCount = typeof globalData.count === 'number' ? globalData.count : 0;
    const userCount = typeof userData.count === 'number' ? userData.count : 0;
    const lastRequestAt = typeof userData.lastRequestAt === 'number' ? userData.lastRequestAt : 0;

    // 1. Cooldown check
    const elapsed = nowMs - lastRequestAt;
    if (elapsed < COOLDOWN_MS) {
      const waitSecs = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      const err = new Error(`Please wait ${waitSecs}s before sending another question.`);
      err.code = 'COOLDOWN_ACTIVE';
      err.waitSecs = waitSecs;
      throw err;
    }

    // 2. User daily limit check
    if (userCount >= USER_DAILY_LIMIT) {
      const err = new Error(`You have reached your daily allowance of ${USER_DAILY_LIMIT} assistant queries for today. Your allowance resets at midnight.`);
      err.code = 'USER_LIMIT_REACHED';
      err.limit = USER_DAILY_LIMIT;
      throw err;
    }

    // 3. Global daily safety limit check
    if (globalCount >= GLOBAL_DAILY_LIMIT) {
      const err = new Error('The campus assistant has reached its maximum daily usage capacity. Please check back tomorrow.');
      err.code = 'GLOBAL_LIMIT_REACHED';
      err.limit = GLOBAL_DAILY_LIMIT;
      throw err;
    }

    const nextUserCount = userCount + 1;
    const nextGlobalCount = globalCount + 1;

    // Atomic transaction updates
    transaction.set(globalRef, {
      count: nextGlobalCount,
      date: dateStr,
      updatedAt: nowMs
    }, { merge: true });

    transaction.set(userRef, {
      uid,
      count: nextUserCount,
      date: dateStr,
      lastRequestAt: nowMs
    }, { merge: true });

    return {
      allowed: true,
      userCount: nextUserCount,
      remainingUserQuota: Math.max(0, USER_DAILY_LIMIT - nextUserCount),
      globalCount: nextGlobalCount
    };
  });
}

/**
 * Read-only check of user's remaining allowance (no counter consumption).
 */
export async function getUserRemainingAllowance(db, uid, tz) {
  try {
    const { dateStr } = getNowInTimezone(tz);
    const userRef = db.doc(`assistantUsage/user_${uid}_${dateStr}`);
    const snap = await userRef.get();
    const count = snap.exists && typeof snap.data().count === 'number' ? snap.data().count : 0;
    return {
      used: count,
      limit: USER_DAILY_LIMIT,
      remaining: Math.max(0, USER_DAILY_LIMIT - count)
    };
  } catch {
    return {
      used: 0,
      limit: USER_DAILY_LIMIT,
      remaining: USER_DAILY_LIMIT
    };
  }
}
