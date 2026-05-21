# Push notifications (FCM) setup

FetchSafe sends **Firebase Cloud Messaging (FCM)** pushes when the app is closed or the user is logged out, as long as they logged in once, allowed notifications, and have a device token saved on `Registerd/{uid}`.

## 1. Firebase Android app (done in repo)

- Firebase Android app **FetchSafe Android** (`io.ionic.starter`) is registered on project **fetchsafe2**.
- Config file: `android/app/google-services.json` (regenerate with):
  ```bash
  npx firebase-tools apps:sdkconfig ANDROID 1:418034723029:android:446cffa25e1465dcb91a5c --project fetchsafe2 -o android/app/google-services.json
  ```

Gradle applies the Google Services plugin when that file exists (`android/app/build.gradle`). Build log should show `processDebugGoogleServices`.

## 2. App settings (user)

1. Install the native app (not only the browser).
2. Sign in at least once.
3. **Settings → Enable app notifications** (ON).
4. Accept the system notification permission prompt.

The app stores `pushToken` on **`Registerd/{uid}`** and `users/{uid}` for Cloud Functions.

## 3. Cloud Functions (server)

These triggers send FCM (deployed with your functions):

| Function | When |
|----------|------|
| `sendPushOnNotificationCreate` | Schedule, pickup, panic, etc. |
| `sendPushOnScanEventCreate` | School check-in / check-out |
| `sendPushOnAnnouncementCreate` | Admin announcements |

Deploy:

```bash
npx firebase-tools deploy --only functions:sendPushOnNotificationCreate,functions:sendPushOnScanEventCreate,functions:sendPushOnAnnouncementCreate
```

## 4. iOS (optional)

1. Add an iOS app in Firebase and download `GoogleService-Info.plist`.
2. Enable Push Notifications + Background Modes in Xcode.
3. Upload your APNs key in Firebase Console → Cloud Messaging.

## 5. Build debug APK

```bash
npm run build:android
cd android
# Windows (Android Studio JBR):
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
gradlew.bat assembleDebug
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`

Install on the phone (USB, `adb install`, or copy the file).

## 6. Troubleshooting

| Issue | Check |
|-------|--------|
| No push after login | `Registerd/{uid}.pushToken` in Firestore |
| Build fails on Android | `google-services.json` present and package name matches |
| Push disabled | `Registerd.appNotifications` is not `false` |
| Invalid token logs | User must open app again to re-register FCM |

SMS and email are separate channels; push does not replace them.
