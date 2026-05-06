/**
 * Resend credentials read by `lib/index.js` when Firebase config is empty.
 *
 * Option A — commit in repo: copy this file to `resend-config.js`, fill values, commit `resend-config.js`.
 * Option B — no file in repo (common for production): set Firebase runtime config, then deploy:
 *   firebase functions:config:set resend.api_key="re_..." resend.from="FetchSafe <onboarding@resend.dev>"
 *   (Config values live in Firebase, not in Git.)
 */
module.exports = {
  RESEND_API_KEY: 're_ES8bve3m_Q6LbqmyMTy2wtPUEDess6byB',
  RESEND_FROM: 'FetchSafe <onboarding@resend.dev>',
};
