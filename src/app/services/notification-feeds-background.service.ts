import { Injectable } from '@angular/core';
import { AuthService } from './auth';
import { FamilyService } from './family.service';
import { NotificationInboxFeedService } from './notification-inbox-feed.service';
import { PickupNotificationLogLoaderService } from './pickup-notification-log-loader.service';

/**
 * Starts background Firestore listeners + cache hydration for:
 * - Notifications inbox (`NotificationInboxFeedService`)
 * - Pick Up Log (`PickupNotificationLogLoaderService`)
 *
 * Invoked from shell chrome (e.g. bottom navigation) so data is already loading
 * before the user opens those routes.
 */
@Injectable({ providedIn: 'root' })
export class NotificationFeedsBackgroundService {
  private lastUid: string | null = null;

  constructor(
    private authService: AuthService,
    private familyService: FamilyService,
    private inboxFeed: NotificationInboxFeedService,
    private pickupLogLoader: PickupNotificationLogLoaderService
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
    }

    await this.inboxFeed.refresh();

    try {
      const family = await this.familyService.getUserFamily();
      if (family?.name) {
        this.pickupLogLoader.start(family.name);
      } else {
        this.pickupLogLoader.stop();
      }
    } catch {
      this.pickupLogLoader.stop();
    }
  }

  stop(): void {
    this.lastUid = null;
    this.inboxFeed.stop();
    this.pickupLogLoader.stop();
  }
}
