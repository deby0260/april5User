/**
 * Email uses Gmail SMTP via nodemailer in lib/index.js (no file like this is required at runtime).
 *
 * Before deploy, create Firebase secrets (values never committed):
 *   firebase functions:secrets:set GMAIL_USER
 *   firebase functions:secrets:set GMAIL_APP_PASSWORD
 *
 * GMAIL_USER: must be the same mailbox as NOTIFICATION_SENDER in lib/index.js
 *   (fetchsafe.notification@gmail.com) so Gmail SMTP auth matches the visible From header.
 * GMAIL_APP_PASSWORD: Google Account → App passwords (2FA required).
 *
 * New `Announcements` docs trigger `sendEmailOnAnnouncementCreate` (broadcast to users with email on).
 * Turning on `Registerd.emailNotifications` triggers `sendPendingNotificationEmailsOnEmailOptIn` for pending inbox rows.
 * Deploy binds secrets to the v2 email functions automatically when prompted, or use:
 *   firebase deploy --only functions
 */

module.exports = {};
