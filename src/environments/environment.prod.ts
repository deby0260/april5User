export const environment = {
  production: true,
  /**
   * Set true only after `android/app/google-services.json` exists and matches
   * your `applicationId` (e.g. io.ionic.starter).
   */
  /** Requires `android/app/google-services.json` — see docs/PUSH_NOTIFICATIONS_SETUP.md */
  enableCapacitorPushRegistration: true,
  firebase: {
    apiKey: "AIzaSyBczGIrG5fC0sUqmd0-dMyohMEpI0JquEM",
    authDomain: "fetchsafe2.firebaseapp.com",
    projectId: "fetchsafe2",
    storageBucket: "fetchsafe2.firebasestorage.app",
    messagingSenderId: "418034723029",
    appId: "1:418034723029:web:9f9bfea5f62a159bb91a5c",
    measurementId: "G-S18Q88ZZ29"
  },
  firebaseFunctionsRegion: 'us-central1',
  maxNotificationEmailsPerSync: 30,
  notificationEmailMode: 'mail_callable' as const,
};
