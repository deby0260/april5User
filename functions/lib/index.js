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
exports.sendNotificationDigestEmails = exports.sendSmsOnNotificationCreate = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const twilio_1 = __importDefault(require("twilio"));
admin.initializeApp();
const SMS_TYPES = new Set([
    "schedule_assignment",
    "pickup_completion",
    "schedule_completion",
]);
function getTwilioConfig() {
    const twilioCfg = functions.config().twilio;
    const accountSid = twilioCfg?.account_sid?.trim();
    const authToken = twilioCfg?.auth_token?.trim();
    const fromNumber = twilioCfg?.from_number?.trim();
    const defaultCc = (twilioCfg?.default_cc || "63").trim();
    if (!accountSid || !authToken || !fromNumber) {
        functions.logger.warn("Twilio not configured. Set: firebase functions:config:set twilio.account_sid=... twilio.auth_token=... twilio.from_number=...");
        return null;
    }
    return { accountSid, authToken, fromNumber, defaultCc };
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
exports.sendSmsOnNotificationCreate = functions.firestore
    .document("Notifications/{docId}")
    .onCreate(async (snap) => {
    const cfg = getTwilioConfig();
    if (!cfg) {
        return null;
    }
    const data = snap.data();
    const type = data?.type;
    const recipientId = data?.recipientId;
    if (!type || !recipientId || !SMS_TYPES.has(type)) {
        return null;
    }
    const rawPhone = await getContactNumberForUid(recipientId);
    if (!rawPhone) {
        functions.logger.warn("No contactNumber in Registerd for recipient", recipientId);
        return null;
    }
    const to = toE164(rawPhone, cfg.defaultCc);
    if (!to) {
        functions.logger.warn("Could not normalize phone", rawPhone);
        return null;
    }
    const messageText = (typeof data.message === "string" && data.message.trim()) ||
        (typeof data.title === "string" && data.title.trim()) ||
        "You have an update in FetchSafe.";
    const body = `[FetchSafe] ${messageText}`;
    try {
        const client = (0, twilio_1.default)(cfg.accountSid, cfg.authToken);
        const result = await client.messages.create({
            body,
            from: cfg.fromNumber,
            to,
        });
        functions.logger.info("Twilio SMS sent", { to, sid: result.sid, type });
    }
    catch (err) {
        functions.logger.error("Twilio SMS failed", err);
    }
    return null;
});
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