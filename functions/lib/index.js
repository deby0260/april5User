"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmailOnScanEventCreate = exports.sendEmailOnNotificationCreate = exports.sendNotificationDigestEmails = exports.sendSmsOnAnnouncementCreate = exports.sendSmsOnNotificationCreate = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
admin.initializeApp();
const SMS_TYPES = new Set([
    "schedule_assignment",
    "pickup_completion",
    "schedule_completion",
]);

function getIprogConfig() {
    const cfg = functions.config().iprog || {};
    const apiToken = cfg?.api_token?.trim?.();
    if (!apiToken) {
        functions.logger.warn('IPROG SMS not configured. Set: firebase functions:config:set iprog.api_token="..."');
        return null;
    }
    return { apiToken };
}
function getResendRepoDefaults() {
    try {
        return require("../resend-config.js");
    }
    catch {
        return {};
    }
}
function getResendConfig() {
    const cfg = functions.config().resend || {};
    const repo = getResendRepoDefaults();
    const apiKey = (cfg?.api_key?.trim?.() || String(repo.RESEND_API_KEY || "").trim()) || null;
    const from = (cfg?.from?.trim?.() || String(repo.RESEND_FROM || "").trim()) || null;
    if (!apiKey || !from) {
        functions.logger.warn('Resend not configured. Add functions/resend-config.js or: firebase functions:config:set resend.api_key="re_..." resend.from="onboarding@resend.dev"');
        return null;
    }
    return { apiKey, from };
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
        // default true if field missing; explicit false disables
        if (!snap.exists) {
            return true;
        }
        const v = snap.get("smsNotifications");
        return v !== false;
    }
    catch {
        return true;
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
    // IPROG docs accept "09xxxxxxxxx" or "639xxxxxxxxx". We'll normalize to digits-only.
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
    // Docs show invalid token can return status 500 with body "Invalid Token"
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`IPROG ${res.status}: ${errText}`);
    }
    // Response is JSON-ish; we don't strictly require it
    try {
        return await res.json();
    }
    catch {
        return await res.text();
    }
}

async function listSmsRecipientUids() {
    // We use Registerd because that's where contactNumber + smsNotifications live in this project.
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
            }
            catch (e) {
                results[i] = e;
            }
        }
    });
    await Promise.all(workers);
    return results;
}
async function sendOneResend(apiKey, from, to, subject, text, html) {
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend ${res.status}: ${errText}`);
    }
}
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function getAuthEmailForUid(uid) {
    if (!uid || uid === "system" || uid === "system_auto" || uid === "auto") {
        return null;
    }
    try {
        const user = await admin.auth().getUser(uid);
        const email = user.email?.trim() ?? "";
        return email || null;
    }
    catch {
        return null;
    }
}

async function isEmailNotificationsEnabledForUid(uid) {
    if (!uid) {
        return false;
    }
    try {
        const snap = await admin.firestore().doc(`Registerd/${uid}`).get();
        // default true if field missing; explicit false disables
        if (!snap.exists) {
            return true;
        }
        const v = snap.get("emailNotifications");
        return v !== false;
    }
    catch {
        return true;
    }
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
    const messageText = (typeof data.message === "string" && data.message.trim()) ||
        (typeof data.title === "string" && data.title.trim()) ||
        "You have an update in FetchSafe.";
    const body = ` ${messageText}`;
    try {
        const result = await sendOneIprogSms(iprog.apiToken, phone, body);
        functions.logger.info("IPROG SMS queued", { recipientId, type, phone, result });
    }
    catch (err) {
        functions.logger.error("IPROG SMS failed", err);
    }
    return null;
});

exports.sendSmsOnAnnouncementCreate = functions.firestore
    .document("Announcements/{docId}")
    .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const title = (typeof data.title === "string" && data.title.trim()) ? data.title.trim() : "Announcement";
    const bodyRaw = (typeof data.body === "string" && data.body.trim()) ? data.body.trim() : "";
    const msg = bodyRaw ? `[FetchSafe] ${title}: ${bodyRaw}` : `[FetchSafe] ${title}`;
    const iprog = getIprogConfig();
    if (!iprog) {
        return null;
    }
    const uids = await listSmsRecipientUids();
    if (!uids.length) {
        return null;
    }
    functions.logger.info("IPROG announcement SMS broadcast queued", { docId: context.params.docId, recipients: uids.length });
    // Limit concurrency to avoid hammering the provider/function runtime.
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
        const result = await sendOneIprogSms(iprog.apiToken, phone, msg);
        functions.logger.info("IPROG announcement SMS queued", { uid, phone, result });
        return null;
    });
    return null;
});

/** Email for items that appear in the mobile Notifications page (Firestore `Notifications` docs). */
exports.sendEmailOnNotificationCreate = functions.firestore
    .document("Notifications/{docId}")
    .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const recipientId = data?.recipientId;
    const title = (typeof data?.title === "string" && data.title.trim()) ? data.title.trim() : "Notification";
    const message = (typeof data?.message === "string" && data.message.trim()) ? data.message.trim() : "";
    if (!recipientId) {
        return null;
    }
    const enabled = await isEmailNotificationsEnabledForUid(recipientId);
    if (!enabled) {
        return null;
    }
    const to = await getAuthEmailForUid(recipientId);
    if (!to) {
        functions.logger.warn("Email notification skipped: no auth email", { recipientId, docId: context.params.docId });
        return null;
    }
    const resend = getResendConfig();
    if (!resend) {
        functions.logger.warn("Email notification skipped: Resend not configured");
        return null;
    }
    const createdAt = data?.createdAt?.toDate ? data.createdAt.toDate() : (data?.createdAt ? new Date(data.createdAt) : new Date());
    const timeLabel = (createdAt instanceof Date && !Number.isNaN(createdAt.getTime())) ? createdAt.toLocaleString("en-US") : "Unknown time";
    const subject = `FetchSafe: ${title}`;
    const text = `${timeLabel}\n\n${message || title}`;
    const html = `<p><strong>${escapeHtml(timeLabel)}</strong></p><p>${escapeHtml(message || title).replace(/\n/g, "<br/>")}</p>`;
    try {
        await sendOneResend(resend.apiKey, resend.from, to, subject, text, html);
        await snap.ref.set({ emailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    catch (e) {
        functions.logger.error("Resend send failed (notification onCreate)", { docId: context.params.docId, err: String(e) });
    }
    return null;
});

/** Email for items that appear in the Notification Log page via `ScanEvents` (Entered/Exited scans). */
exports.sendEmailOnScanEventCreate = functions.firestore
    .document("ScanEvents/{docId}")
    .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const familyName = (typeof data?.familyName === "string" && data.familyName.trim()) ? data.familyName.trim() : "";
    const action = (typeof data?.action === "string" && data.action.trim()) ? data.action.trim() : "Scan";
    const scannedAt = data?.scannedAt?.toDate ? data.scannedAt.toDate() : (data?.scannedAt ? new Date(data.scannedAt) : new Date());
    const timeLabel = (scannedAt instanceof Date && !Number.isNaN(scannedAt.getTime())) ? scannedAt.toLocaleString("en-US") : "Unknown time";
    if (!familyName) {
        return null;
    }
    const resend = getResendConfig();
    if (!resend) {
        functions.logger.warn("Email scan skipped: Resend not configured");
        return null;
    }
    // Send to all family members (Registerd docs) who have emailNotifications enabled and a Firebase Auth email.
    try {
        const regSnap = await admin.firestore()
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
            return null;
        }
        const who = String(data?.authorizerName || data?.authorizerEmail || data?.authorizerUid || "").trim();
        const title = action === "Entered" ? "School check-in" : action === "Exited" ? "School check-out" : "School scan";
        const subtitle = who ? `By: ${who}` : "";
        const subject = `FetchSafe: ${title}`;
        const body = [subtitle, `Family: ${familyName}`].filter(Boolean).join("\n");
        const text = `${timeLabel}\n\n${title}\n${body}`.trim();
        const htmlBody = escapeHtml([title, body].filter(Boolean).join("\n")).replace(/\n/g, "<br/>");
        const html = `<p><strong>${escapeHtml(timeLabel)}</strong></p><p>${htmlBody}</p>`;
        for (const r of recipients) {
            try {
                await sendOneResend(resend.apiKey, resend.from, r.email, subject, text, html);
            }
            catch (e) {
                functions.logger.error("Resend send failed (scan onCreate)", { docId: context.params.docId, uid: r.uid, err: String(e) });
            }
        }
        await snap.ref.set({ emailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    catch (e) {
        functions.logger.error("Scan email handler failed", { docId: context.params.docId, err: String(e) });
    }
    return null;
});

/**
 * Sends notification digest emails via Resend. API key lives in functions config only.
 * Caller must be signed in; destination is always that user's Firebase Auth email.
 */
exports.sendNotificationDigestEmails = functions
    .region("us-central1")
    .https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = context.auth.uid;
    const regSnap = await admin.firestore().doc(`Registerd/${uid}`).get();
    if (regSnap.exists && regSnap.get("emailNotifications") === false) {
        return { emailedIds: [] };
    }
    let to = context.auth.token.email?.trim();
    if (!to) {
        const user = await admin.auth().getUser(uid);
        to = user.email?.trim() ?? "";
    }
    if (!to) {
        throw new functions.https.HttpsError("failed-precondition", "No email on this account.");
    }
    const resend = getResendConfig();
    if (!resend) {
        throw new functions.https.HttpsError("failed-precondition", "Resend is not configured on the server (resend.api_key and resend.from).");
    }
    const rawItems = data?.items;
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
        };
    });
    const emailedIds = [];
    for (const n of items) {
        if (!n.id)
            continue;
        const subject = `FetchSafe: ${n.title}`;
        const text = `${n.time}\n\n${n.displayMessage}`;
        const html = `<p><strong>${escapeHtml(n.time)}</strong></p><p>${escapeHtml(n.displayMessage).replace(/\n/g, "<br/>")}</p>`;
        try {
            await sendOneResend(resend.apiKey, resend.from, to, subject, text, html);
            emailedIds.push(n.id);
        }
        catch (e) {
            functions.logger.error("Resend send failed", { id: n.id, err: String(e) });
        }
    }
    return { emailedIds };
});
//# sourceMappingURL=index.js.map