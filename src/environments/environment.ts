// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  /**
   * `@capacitor/push-notifications` uses Firebase Messaging on device.
   * Without `android/app/google-services.json` (and a matching Firebase Android app),
   * calling register() crashes the app. Set to true only after that file is in place
   * and you run `npx cap sync android`.
   */
  enableCapacitorPushRegistration: false,
  firebase: {
    apiKey: "AIzaSyBczGIrG5fC0sUqmd0-dMyohMEpI0JquEM",
    authDomain: "fetchsafe2.firebaseapp.com",
    projectId: "fetchsafe2",
    storageBucket: "fetchsafe2.firebasestorage.app",
    messagingSenderId: "418034723029",
    appId: "1:418034723029:web:9f9bfea5f62a159bb91a5c",
    measurementId: "G-S18Q88ZZ29"
  },
  /** Firestore collection for the "Trigger Email from Firestore" extension (default: `mail`). */
  notificationEmailCollection: 'mail',
  /** Cap how many notification emails are queued per visit to the Notifications screen. */
  maxNotificationEmailsPerSync: 30,
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
