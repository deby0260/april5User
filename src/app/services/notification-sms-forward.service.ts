import { Injectable } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { NotificationPreferencesService } from './notification-preferences.service';
import type { EmailableNotificationItem } from './notification-email-forward.service';

const SENT_IDS_KEY = 'fetchsafe-sms-notification-ids';
const MAX_STORED_IDS = 800;

/** Cloud Functions already SMS these on Firestore create (avoid double texts). */
const SERVER_HANDLED_TYPES = new Set(['pickup_completion', 'building_scan']);

@Injectable({
  providedIn: 'root',
})
export class NotificationSmsForwardService {
  constructor(
    private functions: Functions,
    private notificationPreferences: NotificationPreferencesService
  ) {}

  isSmsForwardingEnabled(): boolean {
    return this.notificationPreferences.isSmsNotificationsEnabled();
  }

  /**
   * Sends Pick Up Log / digest SMS via `sendNotificationDigestSms` (same items as email digest).
   */
  async forwardNewNotifications(items: EmailableNotificationItem[]): Promise<void> {
    if (!this.isSmsForwardingEnabled()) {
      return;
    }

    const sentIds = this.loadSentIds();
    const pending = items.filter(
      (n) =>
        n.id &&
        !sentIds.has(n.id) &&
        !n.id.startsWith('scan_') &&
        !SERVER_HANDLED_TYPES.has(String(n.type || ''))
    );
    if (pending.length === 0) {
      return;
    }

    const batch = pending.slice(0, 30);

    try {
      const fn = httpsCallable(this.functions, 'sendNotificationDigestSms');
      const res = await fn({
        items: batch.map((n) => ({
          id: n.id,
          title: n.title,
          displayMessage: n.displayMessage,
          time: n.time,
          type: n.type ?? '',
        })),
      });
      const data = res.data as { smsIds?: string[] };
      const smsIds = Array.isArray(data?.smsIds) ? data.smsIds : [];
      for (const id of smsIds) {
        if (id) {
          sentIds.add(id);
        }
      }
      this.persistSentIds(sentIds);
    } catch {
      /* noop */
    }
  }

  private loadSentIds(): Set<string> {
    try {
      const raw = localStorage.getItem(SENT_IDS_KEY);
      if (!raw) {
        return new Set();
      }
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  private persistSentIds(ids: Set<string>): void {
    const arr = [...ids];
    const trimmed = arr.length > MAX_STORED_IDS ? arr.slice(arr.length - MAX_STORED_IDS) : arr;
    localStorage.setItem(SENT_IDS_KEY, JSON.stringify(trimmed));
  }
}
