"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { defineSecret } = require("firebase-functions/params");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

admin.initializeApp();

/** Gmail SMTP via Secret Manager — bound only on functions that send email. */
const gmailUser = defineSecret("GMAIL_USER");
const gmailAppPassword = defineSecret("GMAIL_APP_PASSWORD");

/**
 * Visible From / Reply-To address (must match the Google account used in GMAIL_USER secret
 * for consumer Gmail SMTP — same pattern as admin Cloud Functions).
 */
const NOTIFICATION_SENDER = "fetchsafe.notification@gmail.com";

/** Max inbox notification emails per Registerd opt-in backfill (timeout-safe). */
const EMAIL_OPT_IN_BACKFILL_MAX = 35;

const SMS_TYPES = new Set([
  "schedule_assignment",
  "pickup_completion",
  "schedule_completion",
  "panic_alert",
]);

/** Pick Up Log docs often have no recipientId — SMS every opted-in family member. */
const FAMILY_BROADCAST_SMS_TYPES = new Set(["pickup_completion"]);

/** Same events as SMS — push via FCM when `Registerd.pushToken` is set. */
const PUSH_TYPES = new Set([
  "schedule_assignment",
  "pickup_completion",
  "schedule_completion",
  "panic_alert",
]);
const FAMILY_BROADCAST_PUSH_TYPES = new Set(["pickup_completion"]);

function getIprogConfig() {
  const cfg = functions.config().iprog || {};
  const apiToken = cfg?.api_token?.trim?.();
  if (!apiToken) {
    functions.logger.warn(
      'IPROG SMS not configured. Set: firebase functions:config:set iprog.api_token="..."'
    );
    return null;
  }
  return { apiToken };
}

function createGmailTransporter() {
  const user = gmailUser.value();
  const pass = gmailAppPassword.value();
  if (!user || !pass) {
    throw new Error("Gmail credentials are not configured (GMAIL_USER / GMAIL_APP_PASSWORD).");
  }
  const expected = NOTIFICATION_SENDER.trim().toLowerCase();
  const actual = String(user).trim().toLowerCase();
  if (actual !== expected) {
    functions.logger.warn(
      "GMAIL_USER should match NOTIFICATION_SENDER for Gmail SMTP (admin uses the same mailbox).",
      { expected: NOTIFICATION_SENDER, actual: user }
    );
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

async function sendOneGmailMail(to, subject, text, html) {
  const transporter = createGmailTransporter();
  await transporter.sendMail({
    from: `"FetchSafe" <${NOTIFICATION_SENDER}>`,
    replyTo: NOTIFICATION_SENDER,
    to,
    subject,
    text,
    html,
  });
}

async function getContactNumberForUid(uid) {
  if (!uid || uid === "system" || uid === "system_auto" || uid === "auto") {
    return null;
  }
  const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
  if (!snap.exists) {
    return null;
  }
  const raw = snap.get("contactNumber");
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

async function isSmsNotificationsEnabledForUid(uid) {
  if (!uid) {
    return false;
  }
  try {
    const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
    if (!snap.exists) {
      return false;
    }
    return snap.get("smsNotifications") === true;
  } catch {
    return false;
  }
}

function toE164(raw, defaultCc) {
  const s = raw.trim();
  if (!s) {
    return null;
  }
  if (s.startsWith("+")) {
    const digits = s.replace(/\D/g, "");
    return digits.length ? `+${digits}` : null;
  }
  const digitsOnly = s.replace(/\D/g, "");
  if (!digitsOnly.length) {
    return null;
  }
  if (defaultCc === "63") {
    if (digitsOnly.startsWith("63") && digitsOnly.length >= 12) {
      return `+${digitsOnly}`;
    }
    if (digitsOnly.startsWith("0") && digitsOnly.length >= 10) {
      return `+63${digitsOnly.slice(1)}`;
    }
    if (digitsOnly.length === 10 && digitsOnly.startsWith("9")) {
      return `+63${digitsOnly}`;
    }
  }
  if (digitsOnly.length === 10) {
    return `+${defaultCc}${digitsOnly}`;
  }
  return `+${digitsOnly}`;
}

function toIprogPhone(raw) {
  const e164 = toE164(raw, "63");
  if (!e164) {
    return null;
  }
  return e164.replace(/^\+/, "");
}

async function sendOneIprogSms(apiToken, phoneNumberDigits, message) {
  const url = new URL("https://www.iprogsms.com/api/v1/sms_messages");
  url.searchParams.set("api_token", apiToken);
  url.searchParams.set("phone_number", phoneNumberDigits);
  url.searchParams.set("message", message);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: apiToken,
      phone_number: phoneNumberDigits,
      message,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`IPROG ${res.status}: ${errText}`);
  }
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

async function listSmsRecipientUids() {
  const snap = await admin.firestore().collection("Registerd").get();
  const uids = [];
  snap.forEach((d) => {
    if (d.id && typeof d.id === "string") {
      uids.push(d.id);
    }
  });
  return uids;
}

async function listFamilyRegisterdUids(familyName) {
  const name = String(familyName || "").trim();
  if (!name) {
    return [];
  }
  const snap = await admin
    .firestore()
    .collection("Registerd")
    .where("familyName", "==", name)
    .get();
  const uids = [];
  snap.forEach((d) => {
    if (d.id) {
      uids.push(d.id);
    }
  });
  return uids;
}

async function trySendSmsToUid(iprog, uid, body) {
  const enabled = await isSmsNotificationsEnabledForUid(uid);
  if (!enabled) {
    return { ok: false, reason: "sms_disabled" };
  }
  const rawPhone = await getContactNumberForUid(uid);
  if (!rawPhone) {
    functions.logger.warn("SMS skipped: missing contactNumber", { uid });
    return { ok: false, reason: "no_phone" };
  }
  const phone = toIprogPhone(rawPhone);
  if (!phone) {
    functions.logger.warn("SMS skipped: invalid contactNumber format", { uid });
    return { ok: false, reason: "invalid_phone" };
  }
  try {
    const result = await sendOneIprogSms(iprog.apiToken, phone, body);
    return { ok: true, phone, result };
  } catch (err) {
    functions.logger.error("IPROG SMS failed", { uid, err });
    return { ok: false, reason: "send_failed" };
  }
}

async function broadcastSmsToFamily(familyName, buildBodyForUid) {
  const iprog = getIprogConfig();
  if (!iprog) {
    return;
  }
  const uids = await listFamilyRegisterdUids(familyName);
  if (!uids.length) {
    return;
  }
  await mapLimit(uids, 10, async (uid) => {
    const timeZone = await getTimeZoneForUid(uid);
    const body = buildBodyForUid(timeZone);
    const sent = await trySendSmsToUid(iprog, uid, body);
    if (sent.ok) {
      functions.logger.info("IPROG family SMS queued", {
        uid,
        familyName,
        phone: sent.phone,
      });
    }
    return null;
  });
}

async function isAppNotificationsEnabledForUid(uid) {
  if (!uid) {
    return false;
  }
  try {
    const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
    if (!snap.exists) {
      return true;
    }
    return snap.get("appNotifications") !== false;
  } catch {
    return true;
  }
}

async function getPushTokenForUid(uid) {
  if (!uid) {
    return null;
  }
  const regSnap = await admin.firestore().doc(`Registerd/${uid}`).get();
  if (regSnap.exists) {
    const t = regSnap.get("pushToken");
    if (typeof t === "string" && t.trim()) {
      return t.trim();
    }
  }
  const userSnap = await admin.firestore().doc(`users/${uid}`).get();
  if (userSnap.exists) {
    const t = userSnap.get("pushToken");
    if (typeof t === "string" && t.trim()) {
      return t.trim();
    }
  }
  return null;
}

function fcmStringData(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj || {})) {
    if (val == null) {
      continue;
    }
    out[String(key)] = String(val);
  }
  return out;
}

function truncatePushBody(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 3)}...`;
}

function buildPushPayloadFromNotification(data, type) {
  const title =
    typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "Notification";
  const message =
    (typeof data?.message === "string" && data.message.trim()) ||
    title ||
    "You have an update in FetchSafe.";
  const isPanic = type === "panic_alert";
  const pushTitle = isPanic ? "PANIC ALERT" : `FetchSafe: ${notificationKindLabel(type)}`;
  const pushBody = truncatePushBody(message, 200);
  return {
    title: pushTitle,
    body: pushBody,
    priority: isPanic ? "high" : "normal",
    data: fcmStringData({
      type: type || "general",
      actionUrl: isPanic ? "/notifications" : "/notifications",
      familyName: data?.familyName || "",
      notificationTitle: title,
    }),
  };
}

async function trySendPushToUid(uid, payload) {
  const enabled = await isAppNotificationsEnabledForUid(uid);
  if (!enabled) {
    return { ok: false, reason: "push_disabled" };
  }
  const token = await getPushTokenForUid(uid);
  if (!token) {
    return { ok: false, reason: "no_token" };
  }
  const high = payload.priority === "high";
  try {
    await admin.messaging().send({
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: high ? "high" : "normal",
        notification: {
          channelId: high ? "fetchsafe_emergency" : "fetchsafe_alerts",
          priority: high ? "max" : "default",
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title: payload.title, body: payload.body },
            sound: high ? "default" : "default",
          },
        },
      },
    });
    return { ok: true, token };
  } catch (err) {
    const code = err?.code || err?.errorInfo?.code;
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      try {
        await admin.firestore().doc(`Registerd/${uid}`).set(
          { pushToken: admin.firestore.FieldValue.delete(), lastTokenUpdate: admin.firestore.FieldValue.delete() },
          { merge: true }
        );
      } catch {
        /* noop */
      }
    }
    functions.logger.warn("FCM send failed", { uid, code, err: String(err) });
    return { ok: false, reason: "send_failed" };
  }
}

async function broadcastPushToFamily(familyName, buildPayloadForUid) {
  const uids = await listFamilyRegisterdUids(familyName);
  if (!uids.length) {
    return;
  }
  await mapLimit(uids, 10, async (uid) => {
    const timeZone = await getTimeZoneForUid(uid);
    const payload = buildPayloadForUid(timeZone);
    const sent = await trySendPushToUid(uid, payload);
    if (sent.ok) {
      functions.logger.info("FCM push queued", { uid, familyName });
    }
    return null;
  });
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fallback when Registerd has no `timeZone` (Cloud Functions run in UTC). */
const DEFAULT_EMAIL_TIMEZONE = "Asia/Manila";

function isValidIanaTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim()) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

async function getTimeZoneForUid(uid) {
  if (!uid) {
    return DEFAULT_EMAIL_TIMEZONE;
  }
  try {
    const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
    const tz = snap.get("timeZone");
    if (isValidIanaTimeZone(tz)) {
      return String(tz).trim();
    }
  } catch {
    // noop
  }
  return DEFAULT_EMAIL_TIMEZONE;
}

/** Format Firestore timestamps for email bodies in the recipient's local timezone. */
function formatEmailDateTime(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  const tz = isValidIanaTimeZone(timeZone) ? String(timeZone).trim() : DEFAULT_EMAIL_TIMEZONE;
  return date.toLocaleString("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/** Matches Pick Up Log detail modal `detailTimestamp()`. */
function formatPickupLogDetailTime(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  const tz = isValidIanaTimeZone(timeZone) ? String(timeZone).trim() : DEFAULT_EMAIL_TIMEZONE;
  return date.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Matches Pick Up Log list clock (e.g. "1:25 PM"). */
function formatPickupLogClockTime(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  const tz = isValidIanaTimeZone(timeZone) ? String(timeZone).trim() : DEFAULT_EMAIL_TIMEZONE;
  return date.toLocaleString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function joinPickupLogSmsLines(lines) {
  return lines
    .map((l) => String(l || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function firestoreTimestampToDate(v) {
  if (v == null) {
    return new Date();
  }
  if (typeof v?.toDate === "function") {
    return v.toDate();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function toLocalYmdInTimeZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  const tz = isValidIanaTimeZone(timeZone) ? String(timeZone).trim() : DEFAULT_EMAIL_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return y && m && d ? `${y}-${m}-${d}` : "";
}

function scheduleDateYmdFromFirestore(val) {
  if (val == null) {
    return "";
  }
  if (typeof val === "string") {
    const parts = val.split("-").map((n) => parseInt(n, 10));
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const [y, mo, day] = parts;
      return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return toLocalYmdInTimeZone(d, DEFAULT_EMAIL_TIMEZONE);
    }
    return "";
  }
  if (typeof val?.toDate === "function") {
    return toLocalYmdInTimeZone(val.toDate(), DEFAULT_EMAIL_TIMEZONE);
  }
  return "";
}

function displayNameFromScan(data) {
  const name = String(data?.authorizerName || "").trim();
  if (name) {
    return name;
  }
  const email = String(data?.authorizerEmail || "").trim();
  if (email) {
    return email;
  }
  const uid = String(data?.authorizerUid || "").trim();
  if (uid) {
    return uid;
  }
  return "Pickup person";
}

async function loadScheduledChildNamesIndex(familyName) {
  const idx = new Map();
  const name = String(familyName || "").trim();
  if (!name) {
    return idx;
  }
  const snap = await admin
    .firestore()
    .collection("Schedules")
    .where("Family Name", "==", name)
    .get();
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    const ymd = scheduleDateYmdFromFirestore(d["Date"]);
    const fetcherUid = String(d["Fetcher UID"] || "").trim();
    const child = String(d["Childs Name"] || "").trim();
    if (!ymd || !fetcherUid || !child) {
      return;
    }
    const key = `${ymd}|${fetcherUid}`;
    const bucket = idx.get(key) || { pending: [], completed: [] };
    const status = (d["Status"] || "pending").toString();
    if (status === "pending") {
      bucket.pending.push(child);
    } else if (status === "completed") {
      bucket.completed.push(child);
    }
    idx.set(key, bucket);
  });
  return idx;
}

function resolveScheduledChildNames(index, authorizerUid, scannedAt, timeZone) {
  const scanYmd = toLocalYmdInTimeZone(scannedAt, timeZone);
  const uid = String(authorizerUid || "").trim();
  if (!scanYmd || !uid) {
    return [];
  }
  const bucket = index.get(`${scanYmd}|${uid}`);
  if (!bucket) {
    return [];
  }
  const pick = bucket.pending.length > 0 ? bucket.pending : bucket.completed;
  return [...new Set(pick)].sort((a, b) => a.localeCompare(b));
}

/** Same layout as Pick Up Log detail modal for scan rows (`buildDetailBody`). */
function buildScanPickupLogSmsBody(scanData, scheduleIndex, timeZone) {
  const action =
    typeof scanData?.action === "string" && scanData.action.trim()
      ? scanData.action.trim()
      : "Scan";
  const scannedAt = firestoreTimestampToDate(scanData?.scannedAt);
  const who = displayNameFromScan(scanData);
  const authorizerUid = String(scanData?.authorizerUid || "").trim();
  const children = resolveScheduledChildNames(scheduleIndex, authorizerUid, scannedAt, timeZone);
  const clockLabel = formatPickupLogClockTime(scannedAt, timeZone);

  let headline;
  let title;
  let subtitle;

  if (action === "Entered") {
    headline = "School check-in";
    title = `${who} has arrived at the school at ${clockLabel}`;
    if (children.length === 1) {
      subtitle = `To pick up ${children[0]}`;
    } else if (children.length > 1) {
      subtitle = `To pick up ${children.join(", ")}`;
    } else {
      subtitle = "Arrival recorded";
    }
  } else {
    headline = "School check-out";
    const exitSubtitle = `Exited at ${clockLabel} at the school`;
    if (children.length === 1) {
      title = `${children[0]} was picked up by ${who}`;
      subtitle = exitSubtitle;
    } else if (children.length > 1) {
      title = `${children.join(", ")} were picked up by ${who}`;
      subtitle = exitSubtitle;
    } else {
      headline = "";
      title = `${who} has left the school`;
      subtitle = `${exitSubtitle}. No matching pickup was found for this person today. Confirm the schedule date and fetcher.`;
    }
  }

  const lines = [];
  if (headline) {
    lines.push(headline);
  }
  lines.push(title, subtitle, `Time: ${formatPickupLogDetailTime(scannedAt, timeZone)}`);
  return joinPickupLogSmsLines(lines);
}

/** Pick Up Log `pickup_completion` rows — title, message, then Time line. */
function buildPickupCompletionSmsBody(data, timeZone) {
  const title =
    typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "Pickup";
  const message =
    typeof data?.message === "string" && data.message.trim() ? data.message.trim() : "";
  const createdAt = firestoreTimestampToDate(data?.createdAt);
  const lines = [title, message, `Time: ${formatPickupLogDetailTime(createdAt, timeZone)}`];
  return joinPickupLogSmsLines(lines);
}

async function getAuthEmailForUid(uid) {
  if (!uid || uid === "system" || uid === "system_auto" || uid === "auto") {
    return null;
  }
  try {
    const user = await admin.auth().getUser(uid);
    const email = user.email?.trim() ?? "";
    return email || null;
  } catch {
    return null;
  }
}

async function isEmailNotificationsEnabledForUid(uid) {
  if (!uid) {
    return false;
  }
  try {
    const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
    if (!snap.exists) {
      return true;
    }
    const v = snap.get("emailNotifications");
    return v !== false;
  } catch {
    return true;
  }
}

/** Short label for email subject/body by `Notifications.type` (matches app inbox types). */
function notificationKindLabel(typeRaw) {
  const t = String(typeRaw || "")
    .trim()
    .toLowerCase();
  switch (t) {
    case "admin_announcement":
      return "Announcement";
    case "password_change_required":
      return "Password";
    case "join_request":
      return "Join request";
    case "join_approved":
      return "Join approved";
    case "join_denied":
      return "Join denied";
    case "schedule":
      return "Schedule";
    case "schedule_assignment":
      return "Schedule assignment";
    case "schedule_completion":
      return "Schedule completed";
    case "pickup_completion":
      return "Pickup";
    case "panic_alert":
      return "Emergency";
    case "request":
      return "Request";
    case "success":
      return "Update";
    case "building_scan":
      return "Building scan";
    default:
      return "Notification";
  }
}

/** Plain-text body shared by email and SMS (timestamp, kind label, message). */
function buildNotificationPlainBody(opts) {
  const kind =
    typeof opts.kind === "string" && opts.kind.trim() ? opts.kind.trim() : "Notification";
  const title =
    typeof opts.title === "string" && opts.title.trim() ? opts.title.trim() : "Notification";
  const message =
    typeof opts.message === "string" && opts.message.trim() ? opts.message.trim() : "";
  const createdAt = opts.createdAt?.toDate
    ? opts.createdAt.toDate()
    : opts.createdAt
      ? new Date(opts.createdAt)
      : new Date();
  const timeLabel = formatEmailDateTime(createdAt, opts.timeZone);
  return `${timeLabel}\n\n${kind}\n\n${message || title}`;
}

function buildNotificationEmailParts(data, timeZone) {
  const kind = notificationKindLabel(data?.type);
  const title =
    typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "Notification";
  const message =
    typeof data?.message === "string" && data.message.trim() ? data.message.trim() : "";
  const createdAt = data?.createdAt?.toDate
    ? data.createdAt.toDate()
    : data?.createdAt
      ? new Date(data.createdAt)
      : new Date();
  const timeLabel = formatEmailDateTime(createdAt, timeZone);
  const text = buildNotificationPlainBody({
    kind,
    title,
    message,
    createdAt: data?.createdAt,
    timeZone,
  });
  const subject = `FetchSafe: ${kind} — ${title}`;
  const html = `<p><strong>${escapeHtml(timeLabel)}</strong></p><p style="font-size:14px;color:#444;margin:0 0 10px 0;"><strong>${escapeHtml(kind)}</strong></p><p>${escapeHtml(message || title).replace(/\n/g, "<br/>")}</p>`;
  return { subject, text, html };
}

/**
 * Sends one `Notifications` inbox email if allowed; sets emailedAt on success.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function trySendNotificationInboxEmail(recipientId, snap) {
  const data = snap.data() || {};
  if (data.emailedAt != null) {
    return { ok: false, reason: "already_emailed" };
  }
  if (!recipientId) {
    return { ok: false, reason: "no_recipient" };
  }
  const enabled = await isEmailNotificationsEnabledForUid(recipientId);
  if (!enabled) {
    return { ok: false, reason: "email_disabled" };
  }
  const to = await getAuthEmailForUid(recipientId);
  if (!to) {
    return { ok: false, reason: "no_auth_email" };
  }
  const timeZone = await getTimeZoneForUid(recipientId);
  const { subject, text, html } = buildNotificationEmailParts(data, timeZone);
  await sendOneGmailMail(to, subject, text, html);
  await snap.ref.set({ emailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
}

exports.sendSmsOnNotificationCreate = functions.firestore
  .document("Notifications/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data();
    const type = data?.type;
    if (!type || !SMS_TYPES.has(type)) {
      return null;
    }
    const iprog = getIprogConfig();
    if (!iprog) {
      return null;
    }
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Notification";
    const message =
      (typeof data.message === "string" && data.message.trim()) ||
      title ||
      "You have an update in FetchSafe.";
    const buildBody = (timeZone) => {
      if (type === "pickup_completion") {
        return buildPickupCompletionSmsBody(data, timeZone);
      }
      return buildNotificationPlainBody({
        kind: notificationKindLabel(type),
        title,
        message,
        createdAt: data?.createdAt,
        timeZone,
      });
    };

    const recipientId = data?.recipientId;
    if (recipientId) {
      const timeZone = await getTimeZoneForUid(recipientId);
      const sent = await trySendSmsToUid(iprog, recipientId, buildBody(timeZone));
      if (sent.ok) {
        functions.logger.info("IPROG SMS queued", {
          recipientId,
          type,
          phone: sent.phone,
          result: sent.result,
        });
      }
      return null;
    }

    const familyName =
      typeof data?.familyName === "string" && data.familyName.trim()
        ? data.familyName.trim()
        : "";
    if (FAMILY_BROADCAST_SMS_TYPES.has(type) && familyName) {
      await broadcastSmsToFamily(familyName, buildBody);
      await snap.ref.set(
        { smsBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    return null;
  });

exports.sendSmsOnAnnouncementCreate = functions.firestore
  .document("Announcements/{docId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Announcement";
    const bodyRaw =
      typeof data.body === "string" && data.body.trim() ? data.body.trim() : "";
    const createdAt = data?.createdAt;
    const iprog = getIprogConfig();
    if (!iprog) {
      return null;
    }
    const uids = await listSmsRecipientUids();
    if (!uids.length) {
      return null;
    }
    functions.logger.info("IPROG announcement SMS broadcast queued", {
      docId: context.params.docId,
      recipients: uids.length,
    });
    await mapLimit(uids, 10, async (uid) => {
      const enabled = await isSmsNotificationsEnabledForUid(uid);
      if (!enabled) {
        return null;
      }
      const rawPhone = await getContactNumberForUid(uid);
      if (!rawPhone) {
        return null;
      }
      const phone = toIprogPhone(rawPhone);
      if (!phone) {
        return null;
      }
      const timeZone = await getTimeZoneForUid(uid);
      const msg = buildNotificationPlainBody({
        kind: "Announcement",
        title,
        message: bodyRaw || title,
        createdAt,
        timeZone,
      });
      const result = await sendOneIprogSms(iprog.apiToken, phone, msg);
      functions.logger.info("IPROG announcement SMS queued", { uid, phone, result });
      return null;
    });
    return null;
  });

/**
 * When an admin creates `Announcements/{docId}`, email every user in `Registerd`
 * who has email notifications enabled (same idea as in-app announcement feed + SMS broadcast).
 */
exports.sendEmailOnAnnouncementCreate = onDocumentCreated(
  {
    document: "Announcements/{docId}",
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      return;
    }
    const data = snap.data() || {};
    if (data.emailBroadcastFinished === true) {
      return;
    }
    try {
      createGmailTransporter();
    } catch (e) {
      functions.logger.error("Announcement email: Gmail not configured", {
        docId: event.params.docId,
        err: String(e),
      });
      return;
    }
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Announcement";
    const bodyRaw =
      typeof data.body === "string" && data.body.trim() ? data.body.trim() : "";
    const createdAt = data?.createdAt?.toDate
      ? data.createdAt.toDate()
      : data?.createdAt
        ? new Date(data.createdAt)
        : new Date();
    const kind = "Announcement";
    const subject = `FetchSafe: ${kind} — ${title}`;

    const uids = await listSmsRecipientUids();
    if (!uids.length) {
      return;
    }
    functions.logger.info("Announcement email broadcast queued", {
      docId: event.params.docId,
      registerdRows: uids.length,
    });
    await mapLimit(uids, 10, async (uid) => {
      const enabled = await isEmailNotificationsEnabledForUid(uid);
      if (!enabled) {
        return null;
      }
      const timeZone = await getTimeZoneForUid(uid);
      const timeLabel = formatEmailDateTime(createdAt, timeZone);
      const text = `${timeLabel}\n\n${kind}\n\n${bodyRaw || title}`;
      const html = `<p><strong>${escapeHtml(timeLabel)}</strong></p><p style="font-size:14px;color:#444;margin:0 0 10px 0;"><strong>${escapeHtml(kind)}</strong></p><p>${escapeHtml(bodyRaw || title).replace(/\n/g, "<br/>")}</p>`;
      const to = await getAuthEmailForUid(uid);
      if (!to) {
        return null;
      }
      try {
        await sendOneGmailMail(to, subject, text, html);
      } catch (e) {
        functions.logger.error("Gmail announcement send failed", {
          docId: event.params.docId,
          uid,
          err: String(e),
        });
      }
      return null;
    });
    await snap.ref.set(
      { emailBroadcastFinished: true, emailBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    functions.logger.info("Announcement email broadcast finished", { docId: event.params.docId });
  }
);

/** Email for items in the mobile Notifications inbox (`Notifications` docs). */
exports.sendEmailOnNotificationCreate = onDocumentCreated(
  {
    document: "Notifications/{docId}",
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      return;
    }
    const data = snap.data() || {};
    const recipientId = data?.recipientId;
    if (!recipientId) {
      return;
    }
    try {
      const result = await trySendNotificationInboxEmail(recipientId, snap);
      if (result.ok) {
        return;
      }
      if (result.reason === "no_auth_email") {
        functions.logger.warn("Email notification skipped: no auth email", {
          recipientId,
          docId: event.params.docId,
        });
      }
    } catch (e) {
      functions.logger.error("Gmail send failed (notification onCreate)", {
        docId: event.params.docId,
        err: String(e),
      });
    }
  }
);

/**
 * When a user turns on email notifications on `Registerd`, email any inbox
 * `Notifications` rows that never got emailedAt (e.g. created while email was off).
 */
exports.sendPendingNotificationEmailsOnEmailOptIn = onDocumentUpdated(
  {
    document: "Registerd/{uid}",
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (event) => {
    const change = event.data;
    if (!change) {
      return;
    }
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const uid = event.params.uid;
    if (!uid || uid === "system" || uid === "system_auto" || uid === "auto") {
      return;
    }
    const beforeOn = before.emailNotifications === true;
    const afterOn = after.emailNotifications === true;
    if (beforeOn || !afterOn) {
      return;
    }
    try {
      createGmailTransporter();
    } catch (e) {
      functions.logger.error("Email opt-in backfill: Gmail not configured", {
        uid,
        err: String(e),
      });
      return;
    }
    if (!(await isEmailNotificationsEnabledForUid(uid))) {
      return;
    }
    const to = await getAuthEmailForUid(uid);
    if (!to) {
      functions.logger.warn("Email opt-in backfill skipped: no auth email", { uid });
      return;
    }
    let qs;
    try {
      qs = await admin
        .firestore()
        .collection("Notifications")
        .where("recipientId", "==", uid)
        .limit(80)
        .get();
    } catch (e) {
      functions.logger.error("Email opt-in backfill query failed", { uid, err: String(e) });
      return;
    }
    let sent = 0;
    for (const doc of qs.docs) {
      if (sent >= EMAIL_OPT_IN_BACKFILL_MAX) {
        break;
      }
      try {
        const result = await trySendNotificationInboxEmail(uid, doc);
        if (result.ok) {
          sent++;
        }
      } catch (e) {
        functions.logger.error("Email opt-in backfill send failed", {
          uid,
          id: doc.id,
          err: String(e),
        });
      }
    }
    if (sent > 0) {
      functions.logger.info("Email opt-in backfill completed", { uid, sent });
    }
  }
);

/** Email for `ScanEvents` (check-in / check-out). */
exports.sendEmailOnScanEventCreate = onDocumentCreated(
  {
    document: "ScanEvents/{docId}",
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      return;
    }
    const data = snap.data() || {};
    const familyName =
      typeof data?.familyName === "string" && data.familyName.trim()
        ? data.familyName.trim()
        : "";
    const action =
      typeof data?.action === "string" && data.action.trim() ? data.action.trim() : "Scan";
    const scannedAt = data?.scannedAt?.toDate
      ? data.scannedAt.toDate()
      : data?.scannedAt
        ? new Date(data.scannedAt)
        : new Date();
    if (!familyName) {
      return;
    }
    try {
      const regSnap = await admin
        .firestore()
        .collection("Registerd")
        .where("familyName", "==", familyName)
        .get();
      const recipients = [];
      for (const docSnap of regSnap.docs) {
        const uid = docSnap.id;
        const enabled = await isEmailNotificationsEnabledForUid(uid);
        if (!enabled) {
          continue;
        }
        const email = await getAuthEmailForUid(uid);
        if (email) {
          recipients.push({ uid, email });
        }
      }
      if (recipients.length === 0) {
        return;
      }
      const who = String(data?.authorizerName || data?.authorizerEmail || data?.authorizerUid || "").trim();
      const title =
        action === "Entered"
          ? "School check-in"
          : action === "Exited"
            ? "School check-out"
            : "School scan";
      const subtitle = who ? `By: ${who}` : "";
      const subject = `FetchSafe: School — ${title}`;
      const body = [subtitle, `Family: ${familyName}`].filter(Boolean).join("\n");
      const htmlBody = escapeHtml([title, body].filter(Boolean).join("\n")).replace(/\n/g, "<br/>");
      for (const r of recipients) {
        const timeZone = await getTimeZoneForUid(r.uid);
        const timeLabel = formatEmailDateTime(scannedAt, timeZone);
        const text = `${timeLabel}\n\nSchool\n\n${title}\n${body}`.trim();
        const html = `<p><strong>${escapeHtml(timeLabel)}</strong></p><p style="font-size:14px;color:#444;margin:0 0 10px 0;"><strong>School</strong></p><p>${htmlBody}</p>`;
        try {
          await sendOneGmailMail(r.email, subject, text, html);
        } catch (e) {
          functions.logger.error("Gmail send failed (scan onCreate)", {
            docId: event.params.docId,
            uid: r.uid,
            err: String(e),
          });
        }
      }
      await snap.ref.set({ emailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      functions.logger.error("Scan email handler failed", {
        docId: event.params.docId,
        err: String(e),
      });
    }
  }
);

/** SMS for `ScanEvents` (school check-in / check-out) — mirrors sendEmailOnScanEventCreate. */
exports.sendSmsOnScanEventCreate = functions.firestore
  .document("ScanEvents/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    if (data.smsSentAt != null) {
      return null;
    }
    const familyName =
      typeof data?.familyName === "string" && data.familyName.trim()
        ? data.familyName.trim()
        : "";
    if (!familyName) {
      return null;
    }
    const iprog = getIprogConfig();
    if (!iprog) {
      return null;
    }
    try {
      const scheduleIndex = await loadScheduledChildNamesIndex(familyName);
      await broadcastSmsToFamily(familyName, (timeZone) =>
        buildScanPickupLogSmsBody(data, scheduleIndex, timeZone)
      );
      await snap.ref.set(
        { smsSentAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      functions.logger.error("Scan SMS handler failed", {
        docId: snap.id,
        err: String(e),
      });
    }
    return null;
  });

/** FCM push for `Notifications` inbox rows (recipient or family broadcast). */
exports.sendPushOnNotificationCreate = functions.firestore
  .document("Notifications/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const type = data?.type;
    if (!type || !PUSH_TYPES.has(type)) {
      return null;
    }
    const buildPayload = () => {
      if (type === "pickup_completion") {
        const title =
          typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Pickup";
        const message =
          typeof data.message === "string" && data.message.trim() ? data.message.trim() : title;
        return {
          title: "FetchSafe: Pickup",
          body: truncatePushBody(message, 200),
          priority: "normal",
          data: fcmStringData({
            type: "pickup_completion",
            actionUrl: "/notification-log",
            familyName: data?.familyName || "",
          }),
        };
      }
      return buildPushPayloadFromNotification(data, type);
    };

    const recipientId = data?.recipientId;
    if (recipientId) {
      const sent = await trySendPushToUid(recipientId, buildPayload());
      if (sent.ok) {
        functions.logger.info("FCM push queued", { recipientId, type });
      }
      return null;
    }

    const familyName =
      typeof data?.familyName === "string" && data.familyName.trim()
        ? data.familyName.trim()
        : "";
    if (FAMILY_BROADCAST_PUSH_TYPES.has(type) && familyName) {
      await broadcastPushToFamily(familyName, () => buildPayload());
      await snap.ref.set(
        { pushBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    return null;
  });

/** FCM push for school check-in / check-out (Pick Up Log scan events). */
exports.sendPushOnScanEventCreate = functions.firestore
  .document("ScanEvents/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    if (data.pushSentAt != null) {
      return null;
    }
    const familyName =
      typeof data?.familyName === "string" && data.familyName.trim()
        ? data.familyName.trim()
        : "";
    if (!familyName) {
      return null;
    }
    try {
      const scheduleIndex = await loadScheduledChildNamesIndex(familyName);
      await broadcastPushToFamily(familyName, (timeZone) => {
        const smsBody = buildScanPickupLogSmsBody(data, scheduleIndex, timeZone);
        const parts = smsBody.split("\n\n").filter(Boolean);
        const headline = parts[0] || "School";
        const detail = parts[1] || parts[0] || "Scan update";
        const isCheckIn = headline.toLowerCase().includes("check-in");
        return {
          title: isCheckIn ? "FetchSafe: School check-in" : "FetchSafe",
          body: truncatePushBody(detail, 200),
          priority: "normal",
          data: fcmStringData({
            type: "building_scan",
            actionUrl: "/notification-log",
            familyName,
          }),
        };
      });
      await snap.ref.set(
        { pushSentAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      functions.logger.error("Scan push handler failed", { docId: snap.id, err: String(e) });
    }
    return null;
  });

/** FCM push when admin posts an announcement (all users with app notifications on). */
exports.sendPushOnAnnouncementCreate = functions.firestore
  .document("Announcements/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Announcement";
    const bodyRaw =
      typeof data.body === "string" && data.body.trim() ? data.body.trim() : title;
    const payload = {
      title: "FetchSafe: Announcement",
      body: truncatePushBody(bodyRaw, 200),
      priority: "normal",
      data: fcmStringData({
        type: "admin_announcement",
        actionUrl: "/notifications",
      }),
    };
    const uids = await listSmsRecipientUids();
    await mapLimit(uids, 10, async (uid) => {
      await trySendPushToUid(uid, payload);
      return null;
    });
    return null;
  });

function normalizeEmailInput(email) {
  return String(email || "").trim();
}

function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function findRegisterdDocByEmail(email) {
  const snap = await admin
    .firestore()
    .collection("Registerd")
    .where("email", "==", email)
    .limit(1)
    .get();
  if (snap.empty) {
    return null;
  }
  const docSnap = snap.docs[0];
  return { uid: docSnap.id, data: docSnap.data() };
}

async function ensureFirebaseAuthUser(email, registerd) {
  try {
    const existing = await admin.auth().getUserByEmail(email);
    return existing.uid;
  } catch (e) {
    if (e?.code !== "auth/user-not-found") {
      throw e;
    }
  }
  const password = registerd.data?.password;
  if (typeof password !== "string" || !password.length) {
    throw new HttpsError(
      "failed-precondition",
      "This account cannot be reset online. Please contact the administrator."
    );
  }
  const createParams = {
    email,
    password,
    emailVerified: false,
  };
  if (registerd.uid) {
    createParams.uid = registerd.uid;
  }
  try {
    const created = await admin.auth().createUser(createParams);
    return created.uid;
  } catch (createErr) {
    if (
      createErr?.code === "auth/uid-already-exists" ||
      createErr?.code === "auth/email-already-exists"
    ) {
      const existing = await admin.auth().getUserByEmail(email);
      return existing.uid;
    }
    throw createErr;
  }
}

function buildPasswordResetEmailHtml(resetLink) {
  const safeLink = escapeHtml(resetLink);
  return (
    `<p>You requested a password reset for your FetchSafe account.</p>` +
    `<p><a href="${safeLink}" style="display:inline-block;padding:12px 24px;background:#20b2aa;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">Reset password</a></p>` +
    `<p>Or copy this link into your browser:</p>` +
    `<p style="word-break:break-all;"><a href="${safeLink}">${safeLink}</a></p>` +
    `<p>This link expires in about 1 hour. If you did not request this, you can ignore this email.</p>`
  );
}

/**
 * Callable: send password reset link via Gmail (fetchsafe.notification@gmail.com).
 * Verifies email exists in Registerd, ensures Firebase Auth user, then emails reset link.
 */
exports.requestPasswordReset = onCall(
  {
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
    /** Callable is used while logged out; must allow unauthenticated Cloud Run invoke. */
    invoker: "public",
    cors: [
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      /\.firebaseapp\.com$/,
      /\.web\.app$/,
    ],
  },
  async (request) => {
    const email = normalizeEmailInput(request.data?.email);
    const continueUrl = String(request.data?.continueUrl || "").trim();

    if (!email || !isValidEmailFormat(email)) {
      throw new HttpsError("invalid-argument", "Please enter a valid email address.");
    }
    if (!continueUrl || !/^https?:\/\//i.test(continueUrl)) {
      throw new HttpsError("invalid-argument", "Invalid reset URL.");
    }

    const registerd = await findRegisterdDocByEmail(email);
    if (!registerd) {
      throw new HttpsError(
        "not-found",
        "No account found with this email address. Please check your email or create a new account."
      );
    }

    try {
      createGmailTransporter();
    } catch {
      throw new HttpsError(
        "failed-precondition",
        "Email is not configured on the server (GMAIL_USER and GMAIL_APP_PASSWORD secrets)."
      );
    }

    await ensureFirebaseAuthUser(email, registerd);

    const actionCodeSettings = {
      url: continueUrl,
      handleCodeInApp: true,
    };

    let resetLink;
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);
    } catch (e) {
      functions.logger.error("generatePasswordResetLink failed", {
        email,
        err: String(e),
      });
      throw new HttpsError("internal", "Failed to create reset link. Please try again.");
    }

    const subject = "FetchSafe: Reset your password";
    const text =
      `You requested a password reset for your FetchSafe account.\n\n` +
      `Reset your password: ${resetLink}\n\n` +
      `This link expires in about 1 hour. If you did not request this, you can ignore this email.`;
    const html = buildPasswordResetEmailHtml(resetLink);

    try {
      await sendOneGmailMail(email, subject, text, html);
    } catch (e) {
      functions.logger.error("Password reset email failed", { email, err: String(e) });
      throw new HttpsError("internal", "Failed to send reset email. Please try again later.");
    }

    return { success: true };
  }
);

/**
 * Callable: same contract as before — one email per item, `{ emailedIds }`.
 * Uses Gmail SMTP (secrets on server only).
 */
exports.sendNotificationDigestEmails = onCall(
  {
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const regSnap = await admin.firestore().doc(`Registerd/${uid}`).get();
    if (regSnap.exists && regSnap.get("emailNotifications") === false) {
      return { emailedIds: [] };
    }
    let to = request.auth.token.email?.trim();
    if (!to) {
      const user = await admin.auth().getUser(uid);
      to = user.email?.trim() ?? "";
    }
    if (!to) {
      throw new HttpsError("failed-precondition", "No email on this account.");
    }
    try {
      createGmailTransporter();
    } catch {
      throw new HttpsError(
        "failed-precondition",
        "Gmail is not configured on the server (GMAIL_USER and GMAIL_APP_PASSWORD secrets)."
      );
    }
    const rawItems = request.data?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return { emailedIds: [] };
    }
    const max = 30;
    const items = rawItems.slice(0, max).map((row) => {
      const r = row;
      return {
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        displayMessage: String(r.displayMessage ?? ""),
        time: String(r.time ?? ""),
        type: String(r.type ?? ""),
      };
    });
    const emailedIds = [];
    for (const n of items) {
      if (!n.id) {
        continue;
      }
      const kind = notificationKindLabel(n.type);
      const subject = `FetchSafe: ${kind} — ${n.title}`;
      const text = `${n.time}\n\n${kind}\n\n${n.displayMessage}`;
      const html = `<p><strong>${escapeHtml(n.time)}</strong></p><p style="font-size:14px;color:#444;margin:0 0 10px 0;"><strong>${escapeHtml(kind)}</strong></p><p>${escapeHtml(n.displayMessage).replace(/\n/g, "<br/>")}</p>`;
      try {
        await sendOneGmailMail(to, subject, text, html);
        emailedIds.push(n.id);
      } catch (e) {
        functions.logger.error("Gmail send failed (digest)", { id: n.id, err: String(e) });
      }
    }
    return { emailedIds };
  }
);

/**
 * Callable: Pick Up Log digest SMS to the signed-in user's phone (same shape as email digest).
 */
exports.sendNotificationDigestSms = onCall(
  { region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const enabled = await isSmsNotificationsEnabledForUid(uid);
    if (!enabled) {
      return { smsIds: [] };
    }
    const iprog = getIprogConfig();
    if (!iprog) {
      throw new HttpsError("failed-precondition", "SMS provider is not configured on the server.");
    }
    const rawPhone = await getContactNumberForUid(uid);
    if (!rawPhone) {
      throw new HttpsError(
        "failed-precondition",
        "Add a contact number in Settings to receive SMS."
      );
    }
    const phone = toIprogPhone(rawPhone);
    if (!phone) {
      throw new HttpsError("failed-precondition", "Contact number format is invalid for SMS.");
    }
    const rawItems = request.data?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return { smsIds: [] };
    }
    const max = 30;
    const items = rawItems.slice(0, max).map((row) => {
      const r = row;
      return {
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        displayMessage: String(r.displayMessage ?? ""),
        time: String(r.time ?? ""),
        type: String(r.type ?? ""),
      };
    });
    const smsIds = [];
    for (const n of items) {
      if (!n.id) {
        continue;
      }
      const body =
        String(n.displayMessage || "").trim() ||
        joinPickupLogSmsLines([
          notificationKindLabel(n.type),
          n.title,
          `Time: ${n.time}`,
        ]);
      try {
        await sendOneIprogSms(iprog.apiToken, phone, body);
        smsIds.push(n.id);
      } catch (e) {
        functions.logger.error("IPROG digest SMS failed", { id: n.id, err: String(e) });
      }
    }
    return { smsIds };
  }
);
