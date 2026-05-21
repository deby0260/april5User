# Offline mode

FetchSafe caches data on your device after you load each screen **while online**. When you lose connectivity, the app shows the last saved snapshot plus a yellow banner at the top.

## What works offline

| Screen | Cached data |
|--------|-------------|
| **Notifications** | Inbox list |
| **Pick Up Log** | Merged pickup / scan history |
| **Home** | Upcoming pickups |
| **View Schedule** | Pending schedules |
| **Family** | Members, children, family info |
| **QR Code** | Last generated QR image (24h), via shared cache |

Firestore also uses persistent local cache (`app.module.ts`) so recently visited data may still be available from the SDK.

## First-time setup

1. Sign in while online.
2. Open each screen above once (pull to refresh or revisit the tab).
3. For QR: open **Secure QR Code** online so the image is saved as a data URL.

## Clearing cache

**Settings → Clear cache** runs `localStorage.clear()`, which removes all offline snapshots. Open screens again while online to rebuild them.

## Limitations

- Approve/deny join requests, edit schedules, panic, and new pickups require network.
- Cached lists do not update until you are online again.
- Push notifications and SMS still require server connectivity.
