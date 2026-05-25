import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { NotificationInboxFeedService } from '../../services/notification-inbox-feed.service';
import { NotificationFeedsBackgroundService } from '../../services/notification-feeds-background.service';

@Component({
  selector: 'app-shell-header',
  templateUrl: './shell-header.component.html',
  styleUrls: ['./shell-header.component.scss'],
  standalone: false,
})
export class ShellHeaderComponent implements OnInit, OnDestroy {
  /** Home-style bar, or sub-page with back + logo + bell */
  @Input() layout: 'main' | 'with-back' = 'main';

  unreadCount = 0;
  private unreadSub?: Subscription;

  constructor(
    private location: Location,
    private router: Router,
    private notificationInboxFeed: NotificationInboxFeedService,
    private notificationFeedsBackground: NotificationFeedsBackgroundService
  ) {}

  ngOnInit(): void {
    void this.notificationFeedsBackground.ensureRunning();
    this.unreadSub = this.notificationInboxFeed.unreadCount$.subscribe((count) => {
      this.unreadCount = count;
    });
  }

  ngOnDestroy(): void {
    this.unreadSub?.unsubscribe();
  }

  get unreadBadgeLabel(): string {
    if (this.unreadCount <= 0) {
      return 'Notifications';
    }
    const n = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
    return `Notifications, ${n} unread`;
  }

  get unreadBadgeText(): string {
    if (this.unreadCount <= 0) {
      return '';
    }
    return this.unreadCount > 99 ? '99+' : String(this.unreadCount);
  }

  goBack(): void {
    this.location.back();
  }

  navigateToNotifications(): void {
    void this.router.navigate(['/notifications']);
  }
}
