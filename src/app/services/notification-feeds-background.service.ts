import { Injectable } from '@angular/core';
import { Subscription } from 'rxjs';
import { debounceTime, filter } from 'rxjs/operators';
import { AuthService } from './auth';
import { FamilyService } from './family.service';
import { NotificationInboxFeedService, InboxFeedItem } from './notification-inbox-feed.service';
import {
  PickupNotificationLogLoaderService,
  PickupLogNotificationRow,
} from './pickup-notification-log-loader.service';
import { NotificationService } from './notification.service';
import { NotificationEmailForwardService } from './notification-email-forward.service';
import { NotificationSmsForwardService } from './notification-sms-forward.service';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * Starts background Firestore listeners + cache hydration for:
 * - Notifications inbox (`NotificationInboxFeedService`)
 * - Pick Up Log (`PickupNotificationLogLoaderService`)
 *
 * Invoked from app shell on login so inbox, pickup log, email forward, and
 * pickup reminders run without opening Notifications / Pick Up Log routes.
 */
@Injectable({ providedIn: 'root' })
export class NotificationFeedsBackgroundService {
  private lastUid: string | null = null;
  private inboxEmailForwardSub: Subscription | null = null;
  private pickupLogSmsForwardSub: Subscription | null = null;

  constructor(
    private authService: AuthService,
    private familyService: FamilyService,
    private inboxFeed: NotificationInboxFeedService,
    private pickupLogLoader: PickupNotificationLogLoaderService,
    private notificationService: NotificationService,
    private emailForward: NotificationEmailForwardService,
    private smsForward: NotificationSmsForwardService,
    private notificationPreferences: NotificationPreferencesService
  ) {}

  /**
   * Idempotent for the same signed-in user. Stops feeds when nobody is signed in.
   */
  async ensureRunning(): Promise<void> {
    const u = this.authService.getCurrentUser();
    if (!u?.uid) {
      this.stop();
      return;
    }
    if (this.lastUid !== u.uid) {
      this.lastUid = u.uid;
      this.inboxFeed.start(u.uid);
      this.attachInboxEmailForward();
    }

    await this.notificationPreferences.syncFromFirestore();
    await this.notificationService.syncAppNotificationPreference(
      this.notificationPreferences.isAppNotificationsEnabled()
    );
    void this.notificationService.syncPendingPickupReminders30mForCurrentUser({ force: false });

    const silentInboxRefresh = this.inboxFeed.inbox$.value.length > 0;
    await this.inboxFeed.refresh({ silent: silentInboxRefresh });
    await this.forwardInboxEmails(this.inboxFeed.inbox$.value);

    try {
      const family = await this.familyService.getUserFamily();
      if (family?.name) {
        this.pickupLogLoader.start(family.name);
        this.attachPickupLogSmsForward();
      } else {
        this.pickupLogLoader.stop();
      }
    } catch {
      this.pickupLogLoader.stop();
    }
  }

  stop(): void {
    this.lastUid = null;
    if (this.inboxEmailForwardSub) {
      this.inboxEmailForwardSub.unsubscribe();
      this.inboxEmailForwardSub = null;
    }
    if (this.pickupLogSmsForwardSub) {
      this.pickupLogSmsForwardSub.unsubscribe();
      this.pickupLogSmsForwardSub = null;
    }
    this.inboxFeed.stop();
    this.pickupLogLoader.stop();
  }

  private attachInboxEmailForward(): void {
    if (this.inboxEmailForwardSub) {
      return;
    }
    this.inboxEmailForwardSub = this.inboxFeed.inbox$
      .pipe(
        debounceTime(600),
        filter((list) => list.length > 0)
      )
      .subscribe((list) => void this.forwardInboxEmails(list));
  }

  private attachPickupLogSmsForward(): void {
    if (this.pickupLogSmsForwardSub) {
      return;
    }
    this.pickupLogSmsForwardSub = this.pickupLogLoader.rows$
      .pipe(
        debounceTime(800),
        filter((rows) => rows.length > 0)
      )
      .subscribe((rows) => void this.forwardPickupLogSms(rows));
  }

  private async forwardPickupLogSms(rows: PickupLogNotificationRow[]): Promise<void> {
    if (!this.smsForward.isSmsForwardingEnabled()) {
      return;
    }
    await this.smsForward.forwardNewNotifications(
      rows.map((n) => ({
        id: n.id,
        title: n.title,
        displayMessage: n.message || n.subtitle || n.title,
        time: this.formatPickupLogTime(n),
        type: n.type,
      }))
    );
  }

  private formatPickupLogTime(n: {
    createdAt?: { toDate?: () => Date };
    time?: string;
  }): string {
    if (!n.createdAt) {
      return n.time || '';
    }
    try {
      const d = n.createdAt.toDate ? n.createdAt.toDate() : new Date(n.createdAt as unknown as string);
      if (Number.isNaN(d.getTime())) {
        return n.time || '';
      }
      return d.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return n.time || '';
    }
  }

  private async forwardInboxEmails(list: InboxFeedItem[]): Promise<void> {
    if (!this.emailForward.isEmailForwardingEnabled()) {
      return;
    }
    const user = this.authService.getCurrentUser();
    if (!user?.email) {
      return;
    }
    const emailable = list.filter(
      (n) => n.id && n.type !== 'admin_announcement'
    );
    if (emailable.length === 0) {
      return;
    }
    await this.emailForward.forwardNewNotifications(
      emailable.map((n) => ({
        id: n.id,
        title: n.title,
        displayMessage: n.message,
        time: n.time,
        type: n.type,
      }))
    );
  }
}
