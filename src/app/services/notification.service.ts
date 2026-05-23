import { Injectable } from '@angular/core';
import { Platform } from '@ionic/angular';
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from '@capacitor/push-notifications';
import { LocalNotifications, LocalNotificationSchema } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth';
import {
  Firestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  deleteField,
  query,
  where,
  getDocs,
} from '@angular/fire/firestore';
import { environment } from '../../environments/environment';

export interface NotificationData {
  id?: string;
  title: string;
  body: string;
  type: 'panic' | 'family_update' | 'schedule' | 'general';
  familyName?: string;
  senderName?: string;
  timestamp: Date;
  read: boolean;
  actionUrl?: string;
}

type PickupReminderExtra = {
  kind: 'pickup_reminder_30m';
  /** Unique id for idempotent writes / schedules (e.g. scheduleId + reminderAt). */
  reminderKey: string;
  scheduleId?: string;
  scheduleDate?: string;
  scheduleTime?: string;
  familyName?: string;
  childName?: string;
};

/** Narrow surface for pickup reminder sync (used after login / home / schedule views). */
export interface PickupReminderSync {
  syncPendingPickupReminders30mForCurrentUser(opts?: { force?: boolean }): Promise<void>;
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService implements PickupReminderSync {
  private isInitialized = false;
  /** Push + local listeners attached (reset when user turns off app notifications). */
  private nativeStackAttached = false;

  private static readonly SETTINGS_STORAGE_KEY = 'fetchsafe-settings';
  private static readonly PENDING_PUSH_TOKEN_KEY = 'fetchsafe-pending-push-token';
  private static readonly PICKUP_REMINDER_KEYS_STORAGE = 'fetchsafe-pickup-reminder-keys-v1';
  private static readonly PICKUP_REMINDER_LAST_SYNC_MS = 'fetchsafe-pickup-reminder-last-sync-ms';
  /** Throttled background syncs (e.g. silent view-schedule polls); login / explicit `force` bypass. */
  private static readonly PICKUP_REMINDER_SYNC_MIN_INTERVAL_MS = 2 * 60 * 1000;
  /**
   * Foreground timers keyed by `reminderKey`. Used so the in-app inbox
   * reminder fires at exactly T-30 on web (and as a redundancy net on
   * native). In-memory only — page reloads will re-establish them via
   * {@link syncPendingPickupReminders30mForCurrentUser}.
   */
  private inAppReminderTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private platform: Platform,
    private authService: AuthService,
    private firestore: Firestore
  ) {}

  /**
   * Reads the Settings toggle (localStorage). Default true if unset so existing users keep behavior.
   */
  readAppNotificationsEnabled(): boolean {
    try {
      const raw = localStorage.getItem(NotificationService.SETTINGS_STORAGE_KEY);
      if (!raw) return true;
      const parsed = JSON.parse(raw) as { appNotifications?: boolean };
      return parsed.appNotifications !== false;
    } catch {
      return true;
    }
  }

  /**
   * Apply the "Enable app notifications" setting on the device: permissions, FCM registration, listeners.
   * Call after saving settings (and when enabling) so the phone can receive local + push alerts.
   */
  async syncAppNotificationPreference(enabled: boolean): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    if (!enabled) {
      await this.cancelAllPendingLocalNotifications();
      try {
        await PushNotifications.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        await LocalNotifications.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        await PushNotifications.unregister();
      } catch {
        /* noop */
      }
      this.nativeStackAttached = false;
      this.isInitialized = false;
      await this.clearPushTokenInProfile();
      return;
    }
    await this.attachNativeNotificationStack();
    this.isInitialized = true;
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      if (!Capacitor.isNativePlatform()) {
        this.isInitialized = true;
        return;
      }
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      await this.attachNativeNotificationStack();
      this.isInitialized = true;
    } catch (error) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private async attachNativeNotificationStack(): Promise<void> {
    if (this.nativeStackAttached) {
      return;
    }
    await this.initializePushNotifications();
    await this.initializeLocalNotifications();
    this.nativeStackAttached = true;
  }

  private async cancelAllPendingLocalNotifications(): Promise<void> {
    try {
      const { notifications } = await LocalNotifications.getPending();
      if (!notifications?.length) {
        return;
      }
      await LocalNotifications.cancel({
        notifications: notifications.map((n) => ({ id: n.id })),
      });
    } catch (e) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private async clearPushTokenInProfile(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return;
      }
      const uid = currentUser.uid;
      const payload = {
        pushToken: deleteField(),
        lastTokenUpdate: deleteField(),
      };
      await updateDoc(doc(this.firestore, 'users', uid), payload);
      await setDoc(doc(this.firestore, 'Registerd', uid), payload, { merge: true });
      localStorage.removeItem(NotificationService.PENDING_PUSH_TOKEN_KEY);
    } catch {
      /* noop */
    }
  }

  private async initializePushNotifications() {
    if (!environment.enableCapacitorPushRegistration) {
      return;
    }

    const permission = await PushNotifications.requestPermissions();
    
    if (permission.receive === 'granted') {
      PushNotifications.addListener('registration', async (token: Token) => {
        await this.savePushToken(token.value);
      });
      PushNotifications.addListener('pushNotificationReceived', (notification: PushNotificationSchema) => {
        this.handlePushNotificationReceived(notification);
      });
      PushNotifications.addListener('pushNotificationActionPerformed', (notification: ActionPerformed) => {
        this.handlePushNotificationAction(notification);
      });
      try {
        await PushNotifications.register();
      } catch {
        /* google-services.json missing or FCM misconfigured */
      }
    }
  }

  /**
   * After login: persist any token received before auth, then refresh FCM registration.
   */
  async syncPushTokenAfterLogin(): Promise<void> {
    if (!Capacitor.isNativePlatform() || !this.readAppNotificationsEnabled()) {
      return;
    }
    if (!environment.enableCapacitorPushRegistration) {
      return;
    }
    const pending = localStorage.getItem(NotificationService.PENDING_PUSH_TOKEN_KEY);
    if (pending) {
      await this.savePushToken(pending);
    }
    if (!this.nativeStackAttached) {
      await this.attachNativeNotificationStack();
      this.isInitialized = true;
      return;
    }
    try {
      await PushNotifications.register();
    } catch {
      /* noop */
    }
  }

  private async initializeLocalNotifications() {
    
    const permission = await LocalNotifications.requestPermissions();
    
    if (permission.display === 'granted') {
      LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
        this.handleLocalNotificationAction(notification);
      });
      LocalNotifications.addListener('localNotificationReceived', (notification) => {
        void this.handleLocalNotificationReceived(notification);
      });
    } else {
    }
  }

  private async savePushToken(token: string) {
    const trimmed = String(token || '').trim();
    if (!trimmed) {
      return;
    }
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser?.uid) {
        localStorage.setItem(NotificationService.PENDING_PUSH_TOKEN_KEY, trimmed);
        return;
      }
      await this.persistPushToken(currentUser.uid, trimmed);
      localStorage.removeItem(NotificationService.PENDING_PUSH_TOKEN_KEY);
    } catch {
      /* noop */
    }
  }

  private async persistPushToken(uid: string, token: string): Promise<void> {
    const payload = {
      pushToken: token,
      lastTokenUpdate: new Date(),
    };
    await setDoc(doc(this.firestore, 'Registerd', uid), payload, { merge: true });
    try {
      await updateDoc(doc(this.firestore, 'users', uid), payload);
    } catch {
      await setDoc(doc(this.firestore, 'users', uid), payload, { merge: true });
    }
  }

  private handlePushNotificationReceived(notification: PushNotificationSchema) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }

    const type = String(notification.data?.type || '');
    if (type === 'panic' || type === 'panic_alert') {
      this.handlePanicNotification(notification);
      return;
    }
    if (type === 'panic_alert_resolved') {
      this.showLocalNotification({
        title: 'Emergency resolved',
        body: notification.body || 'The panic alert has been resolved.',
        type: 'general',
        timestamp: new Date(),
        read: false,
      });
    }
  }

  private handlePushNotificationAction(notification: ActionPerformed) {
    if (notification.notification.data?.actionUrl) {
    }
  }

  private handleLocalNotificationAction(notification: any) {
  }

  private async handleLocalNotificationReceived(notification: any): Promise<void> {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      const extra = (notification?.extra || {}) as Partial<PickupReminderExtra> & Record<string, unknown>;
      if (extra.kind !== 'pickup_reminder_30m' || !extra.reminderKey) {
        return;
      }
      await this.writePickupReminderToInAppNotifications(extra as PickupReminderExtra);
    } catch {
      // Intentionally silent.
    }
  }

  private handlePanicNotification(notification: PushNotificationSchema) {
    this.showLocalNotification({
      title: 'PANIC ALERT',
      body: notification.body || 'Emergency alert received',
      type: 'panic',
      timestamp: new Date(),
      read: false
    });
  }

  async showLocalNotification(notificationData: NotificationData) {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      if (!Capacitor.isNativePlatform()) {
        return;
      }

      const notification: LocalNotificationSchema = {
        title: notificationData.title,
        body: notificationData.body,
        id: Date.now(),
        schedule: { at: new Date(Date.now() + 1000) }, 
        sound: notificationData.type === 'panic' ? 'beep.wav' : undefined,
        attachments: undefined,
        actionTypeId: notificationData.type,
        extra: {
          type: notificationData.type,
          familyName: notificationData.familyName,
          actionUrl: notificationData.actionUrl
        }
      };

      await LocalNotifications.schedule({
        notifications: [notification]
      });
    } catch (error) {
    }
  }

  async sendPanicNotification(familyName: string, senderName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: 'PANIC ALERT',
        body: `${senderName} has triggered a panic alert in ${familyName}`,
        type: 'panic',
        familyName: familyName,
        senderName: senderName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/notifications'
      };

      
      await this.showLocalNotification(notificationData);

      
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  async sendFamilyUpdateNotification(title: string, message: string, familyName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: title,
        body: message,
        type: 'family_update',
        familyName: familyName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/created-family'
      };

      await this.showLocalNotification(notificationData);
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  async sendScheduleNotification(title: string, message: string, familyName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: title,
        body: message,
        type: 'schedule',
        familyName: familyName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/view-schedule'
      };

      await this.showLocalNotification(notificationData);
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  /**
   * Loads every pending schedule where this device’s signed-in user is the fetcher
   * and registers the 30-minute-before local notification for each (idempotent).
   * Call after login, from Home, or from View Schedule so reminders work without
   * opening the schedule list first. When `force` is false, skips if last sync
   * was within {@link NotificationService.PICKUP_REMINDER_SYNC_MIN_INTERVAL_MS}
   * to limit Firestore reads during background refreshes.
   */
  public async syncPendingPickupReminders30mForCurrentUser(opts?: { force?: boolean }): Promise<void> {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    // No native bail-out: schedulePickupReminder30m now handles BOTH the
    // device-level alarm (native only) AND the in-app inbox write (every
    // platform), so this method must run on web too.
    const user = this.authService.getCurrentUser();
    if (!user?.uid) {
      return;
    }

    const force = opts?.force === true;
    if (!force) {
      try {
        const raw = localStorage.getItem(NotificationService.PICKUP_REMINDER_LAST_SYNC_MS);
        const last = raw ? parseInt(raw, 10) : 0;
        if (last && Date.now() - last < NotificationService.PICKUP_REMINDER_SYNC_MIN_INTERVAL_MS) {
          return;
        }
      } catch {
        /* noop */
      }
    }

    try {
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const q = query(schedulesCollection, where('Fetcher UID', '==', user.uid));
      const snap = await getDocs(q);
      const todayYmd = this.todayLocalYmd();

      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        const status = String(data['Status'] ?? 'pending');
        if (status !== 'pending') {
          continue;
        }
        const dateYmd = this.scheduleDateFieldToYmd(data['Date']);
        if (!dateYmd || dateYmd < todayYmd) {
          continue;
        }
        const time = String(data['Time'] ?? '').trim();
        const childName = String(data['Childs Name'] ?? '').trim();
        const familyName = String(data['Family Name'] ?? '').trim();
        if (!time || !childName || !familyName) {
          continue;
        }
        await this.schedulePickupReminder30m({
          scheduleId: d.id,
          familyName,
          childName,
          scheduleDateYmd: dateYmd,
          scheduleTime: time,
        });
      }

      try {
        localStorage.setItem(NotificationService.PICKUP_REMINDER_LAST_SYNC_MS, String(Date.now()));
      } catch {
        /* noop */
      }
    } catch {
      /* noop */
    }
  }

  private todayLocalYmd(): string {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  /** Normalise Firestore `Date` (string or Timestamp) to local calendar YYYY-MM-DD. */
  private scheduleDateFieldToYmd(val: unknown): string {
    if (val == null) {
      return '';
    }
    if (typeof val === 'string') {
      const parts = val.split('-').map((n) => parseInt(n, 10));
      if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
        const [y, m, d] = parts;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      const parsed = new Date(val);
      if (!Number.isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const mo = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${mo}-${day}`;
      }
      return '';
    }
    if (typeof val === 'object' && val !== null && typeof (val as { toDate?: () => Date }).toDate === 'function') {
      const d = (val as { toDate: () => Date }).toDate();
      if (!d || Number.isNaN(d.getTime())) {
        return '';
      }
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${day}`;
    }
    return '';
  }

  /**
   * Schedules a local reminder for the currently signed-in user (typically the assigned fetcher/companion)
   * and ensures the reminder shows up inside the in-app Notifications feed at delivery time.
   *
   * Dedupe:
   * - device-level: localStorage remembers scheduled reminder keys
   * - Firestore-level: reminder doc id is deterministic (reminderKey)
   */
  async schedulePickupReminder30m(input: {
    scheduleId: string;
    familyName: string;
    childName: string;
    scheduleDateYmd: string; // YYYY-MM-DD
    scheduleTime: string; // "HH:mm" or "h:mm AM/PM"
  }): Promise<void> {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      const pickupAt = this.computeReminderAtLocal(input.scheduleDateYmd, input.scheduleTime, 0);
      const reminderAt = this.computeReminderAtLocal(input.scheduleDateYmd, input.scheduleTime, 30);
      if (!pickupAt || !reminderAt) {
        return;
      }
      const now = Date.now();
      // Pickup already started or ended — nothing to remind.
      if (pickupAt.getTime() <= now) {
        return;
      }

      const reminderKey = `pickupReminder30m:${input.scheduleId}:${reminderAt.toISOString()}`;
      const extra: PickupReminderExtra = {
        kind: 'pickup_reminder_30m',
        reminderKey,
        scheduleId: input.scheduleId,
        scheduleDate: input.scheduleDateYmd,
        scheduleTime: input.scheduleTime,
        familyName: input.familyName,
        childName: input.childName,
      };

      // 1) In-app inbox: works on every platform (web + native). If the
      //    30-min mark has already passed we write right away; otherwise we
      //    set a foreground timer to write at exactly T-30. The Firestore
      //    doc id is deterministic so re-runs are idempotent.
      this.ensureInAppPickupReminder(reminderKey, extra, reminderAt, pickupAt);

      // 2) Device-level OS alarm: native-only. Even if the user kills the
      //    web tab, the OS will still wake the app and surface the reminder.
      if (!Capacitor.isNativePlatform()) {
        return;
      }
      if (this.hasScheduledPickupReminderKey(reminderKey)) {
        return;
      }

      /**
       * Never skip just because we're "close" to T-30: the old `reminderAt <= now + 5s`
       * guard incorrectly dropped every schedule when sync ran within ~5s *before*
       * the alarm (e.g. 6:59:57 for a 7:00 reminder). If we're past T-30 but before
       * pickup, schedule a near-immediate local notification so the user still gets
       * the alert + in-app feed via `localNotificationReceived`.
       */
      const soon = new Date(now + 2_000);
      let scheduleAt = reminderAt;
      if (scheduleAt.getTime() <= now + 15_000) {
        scheduleAt = soon;
      }
      if (scheduleAt.getTime() >= pickupAt.getTime()) {
        scheduleAt = new Date(Math.max(now + 2_000, pickupAt.getTime() - 60_000));
      }
      if (scheduleAt.getTime() >= pickupAt.getTime()) {
        return;
      }

      const title = 'Pickup in 30 minutes';
      const body = `${input.childName} pickup is scheduled at ${this.formatClockTo12h(input.scheduleTime)}.`;

      const notification: LocalNotificationSchema = {
        title,
        body,
        id: this.localNotificationIdFromKey(reminderKey),
        schedule: { at: scheduleAt },
        actionTypeId: 'schedule',
        extra,
      };

      await LocalNotifications.schedule({ notifications: [notification] });
      this.rememberScheduledPickupReminderKey(reminderKey);
    } catch {
      // Intentionally silent.
    }
  }

  /**
   * Ensures the 30-minute pickup reminder appears in the in-app Notifications
   * inbox — works on every platform, no Capacitor required. If the reminder
   * time has already passed (and pickup is still upcoming) we write to
   * Firestore immediately; otherwise we hold a foreground timer that writes
   * at exactly T-30. The write is idempotent (deterministic doc id), and we
   * dedupe in-flight timers per `reminderKey` so repeated sync runs don't
   * stack timeouts in memory.
   */
  private ensureInAppPickupReminder(
    reminderKey: string,
    extra: PickupReminderExtra,
    reminderAt: Date,
    pickupAt: Date,
  ): void {
    try {
      const now = Date.now();
      const reminderTs = reminderAt.getTime();

      // Past reminder time but pickup still ahead → catch-up write so the
      // user immediately sees an inbox entry on app open.
      if (reminderTs <= now + 1_000) {
        void this.writePickupReminderToInAppNotifications(extra);
        return;
      }

      // Future reminder. Skip if a live timer is already pending for this key
      // in this session — protects against duplicate setTimeouts when sync
      // is invoked from multiple entry points (login, home, scheduling save).
      if (this.inAppReminderTimers.has(reminderKey)) {
        return;
      }

      // Snapshot the user so a logout / account switch before the timer
      // fires doesn't write the reminder against the wrong recipient.
      const ownerUid = this.authService.getCurrentUser()?.uid;
      if (!ownerUid) {
        return;
      }

      // Cap the wait so very-long-horizon schedules don't park a 24h+
      // timeout that the engine may collapse to 0; shorter timers will be
      // re-scheduled on the next sync (login / home enter).
      const delayMs = Math.min(reminderTs - now, 24 * 60 * 60 * 1000);
      const timerId = setTimeout(() => {
        this.inAppReminderTimers.delete(reminderKey);
        void (async () => {
          try {
            if (Date.now() >= pickupAt.getTime()) return;
            const cur = this.authService.getCurrentUser();
            if (!cur?.uid || cur.uid !== ownerUid) return;
            await this.writePickupReminderToInAppNotifications(extra);
          } catch {
            // noop
          }
        })();
      }, delayMs);
      this.inAppReminderTimers.set(reminderKey, timerId);
    } catch {
      // noop
    }
  }

  private localNotificationIdFromKey(key: string): number {
    // Stable 31-bit int hash for Capacitor LocalNotifications id
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 2_000_000_000;
  }

  private hasScheduledPickupReminderKey(key: string): boolean {
    try {
      const raw = localStorage.getItem(NotificationService.PICKUP_REMINDER_KEYS_STORAGE);
      if (!raw) return false;
      const arr = JSON.parse(raw) as string[];
      if (!Array.isArray(arr)) return false;
      return arr.includes(key);
    } catch {
      return false;
    }
  }

  private rememberScheduledPickupReminderKey(key: string): void {
    try {
      const raw = localStorage.getItem(NotificationService.PICKUP_REMINDER_KEYS_STORAGE);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      const next = Array.isArray(arr) ? arr : [];
      if (!next.includes(key)) {
        next.push(key);
      }
      // Keep bounded so it doesn't grow forever.
      const trimmed = next.slice(-400);
      localStorage.setItem(
        NotificationService.PICKUP_REMINDER_KEYS_STORAGE,
        JSON.stringify(trimmed)
      );
    } catch {
      // noop
    }
  }

  private computeReminderAtLocal(
    dateYmd: string,
    timeStr: string,
    minutesBefore: number
  ): Date | null {
    const dparts = String(dateYmd || '').split('-').map((n) => parseInt(n, 10));
    if (dparts.length !== 3 || dparts.some((n) => Number.isNaN(n))) {
      return null;
    }
    const [y, m, day] = dparts;
    const minutes = this.parseClockToMinutes(timeStr);
    if (minutes == null) {
      return null;
    }
    const base = new Date(y, m - 1, day, 0, 0, 0, 0);
    const at = new Date(base.getTime() + minutes * 60_000);
    at.setMinutes(at.getMinutes() - minutesBefore);
    return at;
  }

  private parseClockToMinutes(timeStr: string): number | null {
    let t = String(timeStr || '').trim();
    if (!t) return null;
    // `ion-input type="time"` / some locales can emit fractional seconds ("19:30:00.000"),
    // which used to make this parser return null and skip all reminders silently.
    const dot = t.indexOf('.');
    if (dot !== -1) {
      t = t.slice(0, dot);
    }
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const ap = ampm[4].toUpperCase();
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      const h = parseInt(h24[1], 10);
      const m = parseInt(h24[2], 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, m));
    }
    return null;
  }

  /**
   * Render any reasonable clock string as a single, unambiguous "h:mm AM/PM".
   *
   * Defensive against:
   *   - 24h `HH:mm`, `HH:mm:ss`, `HH:mm:ss.SSS` from `<ion-input type="time">`
   *   - 12h "h:mm AM" / "h:mm pm" with mixed casing or missing space
   *   - Malformed legacy data with TWO meridiem markers ("8:30 AM PM"),
   *     which previously surfaced verbatim. The LAST marker now wins.
   *   - Empty / unparseable input → empty string (safer than echoing junk).
   */
  private formatClockTo12h(timeStr: string): string {
    let t = String(timeStr || '').trim();
    if (!t) return '';
    const dot = t.indexOf('.');
    if (dot !== -1) {
      t = t.slice(0, dot);
    }
    const upper = t.toUpperCase();
    const lastAm = upper.lastIndexOf('AM');
    const lastPm = upper.lastIndexOf('PM');
    let isPm: boolean | null = null;
    if (lastAm !== -1 || lastPm !== -1) {
      isPm = lastPm > lastAm;
    }
    const numeric = upper.replace(/AM|PM/g, '').trim();
    const m = numeric.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return t;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min)) return t;

    if (isPm === null) {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${String(min).padStart(2, '0')} ${ampm}`;
    }
    if (isPm && h !== 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(min).padStart(2, '0')} ${ampm}`;
  }

  private async writePickupReminderToInAppNotifications(extra: PickupReminderExtra): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser?.uid) return;

    const message = `30 minutes before pick up schedule: ${extra.childName || 'Child'} at ${this.formatClockTo12h(extra.scheduleTime || '')}.`;
    const ref = doc(this.firestore, 'Notifications', extra.reminderKey);
    await setDoc(
      ref,
      {
        type: 'schedule',
        title: 'Pickup Reminder',
        message,
        recipientId: currentUser.uid,
        senderId: currentUser.uid,
        senderName: currentUser.fullName || currentUser.email || 'Family Member',
        familyName: extra.familyName || '',
        scheduleDate: extra.scheduleDate || '',
        scheduleTime: extra.scheduleTime || '',
        scheduleId: extra.scheduleId || '',
        isRead: false,
        createdAt: new Date(),
      },
      { merge: true }
    );
  }

  private async saveNotificationToHistory(notificationData: NotificationData) {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const notificationRef = doc(collection(this.firestore, 'notifications'));
      await setDoc(notificationRef, {
        ...notificationData,
        userId: currentUser.uid,
        id: notificationRef.id
      });
    } catch (error) {
    }
  }

  async clearAllNotifications() {
    try {
      if (Capacitor.isNativePlatform()) {
        await this.cancelAllPendingLocalNotifications();
      }
    } catch (error) {
    }
  }

  async getPushToken(): Promise<string | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return null;
      }
      const regSnap = await getDoc(doc(this.firestore, 'Registerd', currentUser.uid));
      if (regSnap.exists()) {
        const t = regSnap.get('pushToken');
        if (typeof t === 'string' && t.trim()) {
          return t.trim();
        }
      }
      const userDoc = await getDoc(doc(this.firestore, 'users', currentUser.uid));
      if (userDoc.exists()) {
        const t = userDoc.data()['pushToken'];
        return typeof t === 'string' && t.trim() ? t.trim() : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  
  async sendTestNotification() {
    try {
      const testNotification: NotificationData = {
        title: 'Test Notification',
        body: 'This is a test notification to verify the system is working correctly.',
        type: 'general',
        timestamp: new Date(),
        read: false,
        actionUrl: '/home'
      };

      await this.showLocalNotification(testNotification);
    } catch (error) {
    }
  }
}
