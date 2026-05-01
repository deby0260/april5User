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
exports.sendSmsOnNotificationCreate = void 0;
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
/**
 * Best-effort E.164 for Twilio. Default country code from config (63 = Philippines).
 */
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
//# sourceMappingURL=index.js.map