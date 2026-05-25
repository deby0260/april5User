import { Injectable } from '@angular/core';
import { Firestore, collection, getDocs, onSnapshot, query, where } from '@angular/fire/firestore';
import { BehaviorSubject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { AuthService } from './auth';
import { JoinRequestService } from './join-request.service';
import { OfflineCacheKeys, OfflineCacheService } from './offline-cache.service';

/** Same shape as `Notification` in notifications.page.ts (kept minimal for the feed). */
export interface InboxFeedItem {
  id: string;
  type:
    | 'schedule'
    | 'request'
    | 'success'
    | 'join_request'
    | 'join_approved'
    | 'join_denied'
    | 'schedule_completion'
    | 'schedule_assignment'
    | 'pickup_completion'
    | 'panic_alert'
    | 'panic_alert_resolved'
    | 'password_change_required'
    | 'admin_announcement';
  title: string;
  message: string;
  time: string;
  sortTime: number;
  isRead: boolean;
  joinRequestId?: string;
  joinRequestStatus?: 'pending' | 'approved' | 'denied';
  joinRequestRole?: 'parent' | 'companion';
  senderId?: string;
  senderName?: string;
  familyName?: string;
  passwordChanged?: boolean;
}

@Injectable({ providedIn: 'root' })
export class NotificationInboxFeedService {
  private static readonly ANNOUNCEMENTS_COLLECTION = 'Announcements';

  readonly inbox$ = new BehaviorSubject<InboxFeedItem[]>([]);
  readonly inboxLoading$ = new BehaviorSubject<boolean>(true);
  readonly fromOfflineCache$ = new BehaviorSubject<boolean>(false);
  /** Unread count for header badge (same rules as notifications page `!isRead`). */
  readonly unreadCount$ = new BehaviorSubject<number>(0);

  private uid: string | null = null;
  private unsubs: Array<() => void> = [];
  private debounceSub: Subscription | null = null;
  private readonly refreshTrigger$ = new BehaviorSubject<void>(undefined);

  constructor(
    private firestore: Firestore,
    private authService: AuthService,
    private joinRequestService: JoinRequestService,
    private offlineCache: OfflineCacheService
  ) {}

  stop(): void {
    this.uid = null;
    if (this.debounceSub) {
      this.debounceSub.unsubscribe();
      this.debounceSub = null;
    }
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* noop */
      }
    }
    this.unsubs = [];
    this.publishInbox([]);
  }

  /** Start realtime listeners + debounced full reload for the signed-in user. */
  start(uid: string): void {
    const id = String(uid || '').trim();
    if (!id) {
      this.stop();
      this.publishInbox([]);
      return;
    }
    if (this.uid === id && this.unsubs.length > 0) {
      void this.refresh({ silent: true });
      return;
    }
    this.stop();
    this.uid = id;

    const annCol = collection(this.firestore, NotificationInboxFeedService.ANNOUNCEMENTS_COLLECTION);
    const notifCol = collection(this.firestore, 'Notifications');
    const qNotifs = query(notifCol, where('recipientId', '==', id));

    this.debounceSub = this.refreshTrigger$
      .pipe(debounceTime(200))
      .subscribe(() => {
        const silent = this.inbox$.value.length > 0;
        void this.refresh({ silent });
      });

    this.unsubs.push(
      onSnapshot(annCol, () => this.refreshTrigger$.next(), () => {})
    );
    this.unsubs.push(
      onSnapshot(qNotifs, () => this.refreshTrigger$.next(), () => {})
    );

    void this.refresh();
  }

  /** Full reload (also callable after mark-read / approve flows on the page). */
  async refresh(options?: { silent?: boolean }): Promise<InboxFeedItem[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.publishInbox([]);
      this.inboxLoading$.next(false);
      return [];
    }
    const hasContent = this.inbox$.value.length > 0;
    const silent = options?.silent ?? hasContent;
    if (!silent) {
      this.inboxLoading$.next(true);
    }
    const cacheKey = OfflineCacheKeys.inbox(currentUser.uid);
    try {
      const result = await this.offlineCache.loadWithOfflineFallback(cacheKey, async () => {
        const [announcementItems, userItems] = await Promise.all([
          this.fetchAnnouncements(currentUser),
          this.loadUserNotificationItems(currentUser.uid),
        ]);
        return [...announcementItems, ...userItems].sort((a, b) => b.sortTime - a.sortTime);
      });
      this.fromOfflineCache$.next(result.fromCache);
      this.publishInbox(result.data);
      return result.data;
    } catch {
      const cached = this.offlineCache.load<InboxFeedItem[]>(cacheKey);
      if (cached?.length) {
        this.fromOfflineCache$.next(true);
        this.offlineCache.setBannerActive(true);
        this.publishInbox(cached);
        return cached;
      }
      this.fromOfflineCache$.next(false);
      this.publishInbox([]);
      return [];
    } finally {
      this.inboxLoading$.next(false);
    }
  }

  /** Optimistic read state for header badge + inbox list. */
  markAsReadInInbox(notificationId: string): void {
    const id = String(notificationId || '').trim();
    if (!id) {
      return;
    }
    const next = this.inbox$.value.map((item) =>
      item.id === id ? { ...item, isRead: true } : item
    );
    this.publishInbox(next);
  }

  private publishInbox(items: InboxFeedItem[]): void {
    this.inbox$.next(items);
    this.unreadCount$.next(this.countUnread(items));
  }

  private countUnread(items: InboxFeedItem[]): number {
    return items.filter((item) => !item.isRead).length;
  }

  private getTimestampMs(timestamp: any): number {
    try {
      const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
      const ms = date?.getTime?.();
      return typeof ms === 'number' && !Number.isNaN(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }

  private formatTime(timestamp: any): string {
    if (!timestamp) return 'Unknown';

    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      const timeOfDay = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      if (diffDays === 0) {
        return `Today, ${timeOfDay}`;
      } else if (diffDays === 1) {
        return `Yesterday, ${timeOfDay}`;
      } else if (diffDays < 7) {
        return `${diffDays} days ago, ${timeOfDay}`;
      } else {
        return `${date.toLocaleDateString()}, ${timeOfDay}`;
      }
    } catch {
      return 'Unknown';
    }
  }

  private async fetchAnnouncements(currentUser: any | null): Promise<InboxFeedItem[]> {
    try {
      const userCreatedAtMs =
        currentUser?.createdAt != null ? this.getTimestampMs(currentUser.createdAt) : 0;

      const col = collection(this.firestore, NotificationInboxFeedService.ANNOUNCEMENTS_COLLECTION);
      const snap = await getDocs(col);
      const items: InboxFeedItem[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as {
          title?: string;
          body?: string;
          createdAt?: unknown;
        };
        const annMs = this.getTimestampMs(data.createdAt);
        if (userCreatedAtMs > 0 && annMs > 0 && annMs < userCreatedAtMs) {
          return;
        }
        const body = typeof data.body === 'string' ? data.body : '';
        const title =
          typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Announcement';
        items.push({
          id: docSnap.id,
          type: 'admin_announcement',
          title,
          message: body,
          time: this.formatTime(data.createdAt),
          sortTime: annMs,
          isRead: true,
        });
      });
      return items;
    } catch {
      return [];
    }
  }

  private async loadUserNotificationItems(uid: string): Promise<InboxFeedItem[]> {
    const realNotifications = await this.joinRequestService.getUserNotifications(uid);
    return Promise.all(
      realNotifications.map(async (notification) => {
        let joinRequestStatus: 'pending' | 'approved' | 'denied' | undefined;
        let joinRequestRole: 'parent' | 'companion' | undefined;

        if (notification.type === 'join_request' && notification.joinRequestId) {
          const jr = await this.joinRequestService.getJoinRequestById(notification.joinRequestId);
          if (jr) {
            joinRequestStatus = jr.status;
            joinRequestRole = jr.role;
          }
        }

        const triggeredBySelf =
          (notification as { triggeredBySelf?: boolean }).triggeredBySelf === true ||
          (String(notification.senderId || '').trim() &&
            String(notification.senderId).trim() === String(uid).trim());

        const isSelfPanic = notification.type === 'panic_alert' && triggeredBySelf;
        const isSelfPanicResolved =
          notification.type === 'panic_alert_resolved' && triggeredBySelf;

        let message = notification.message;
        if (isSelfPanic) {
          message =
            notification.message ||
            'You triggered an emergency panic alert. Admin and family have been notified.';
        } else if (notification.type === 'panic_alert' && notification.senderName) {
          message = `Emergency alert triggered by ${notification.senderName}`;
        } else if (isSelfPanicResolved) {
          message =
            notification.message ||
            'Your panic alert has been marked resolved. The emergency is over.';
        } else if (notification.type === 'panic_alert_resolved') {
          message =
            notification.message ||
            'The panic alert for your family has been resolved. The emergency is over.';
        }

        return {
          id: notification.id || '',
          type: notification.type as InboxFeedItem['type'],
          title: notification.title,
          message,
          time: this.formatTime(notification.createdAt),
          sortTime: this.getTimestampMs(notification.createdAt),
          isRead: notification.isRead,
          joinRequestId: notification.joinRequestId,
          joinRequestStatus,
          joinRequestRole,
          senderId: notification.senderId,
          senderName: notification.senderName,
          familyName: notification.familyName,
          passwordChanged: (notification as any).passwordChanged === true,
        } as InboxFeedItem;
      })
    );
  }
}
