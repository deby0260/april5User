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
]);

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
    const recipientId = data?.recipientId;
    if (!type || !recipientId || !SMS_TYPES.has(type)) {
      return null;
    }
    const enabled = await isSmsNotificationsEnabledForUid(recipientId);
    if (!enabled) {
      return null;
    }
    const iprog = getIprogConfig();
    if (!iprog) {
      return null;
    }
    const rawPhone = await getContactNumberForUid(recipientId);
    if (!rawPhone) {
      functions.logger.warn("SMS skipped: missing contactNumber", { recipientId });
      return null;
    }
    const phone = toIprogPhone(rawPhone);
    if (!phone) {
      functions.logger.warn("SMS skipped: invalid contactNumber format", { recipientId });
      return null;
    }
    const timeZone = await getTimeZoneForUid(recipientId);
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Notification";
    const message =
      (typeof data.message === "string" && data.message.trim()) ||
      title ||
      "You have an update in FetchSafe.";
    const body = buildNotificationPlainBody({
      kind: notificationKindLabel(type),
      title,
      message,
      createdAt: data?.createdAt,
      timeZone,
    });
    try {
      const result = await sendOneIprogSms(iprog.apiToken, phone, body);
      functions.logger.info("IPROG SMS queued", { recipientId, type, phone, result });
    } catch (err) {
      functions.logger.error("IPROG SMS failed", err);
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
