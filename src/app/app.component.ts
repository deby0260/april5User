import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Platform } from '@ionic/angular';
import { Subject } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { NotificationService } from './services/notification.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent implements OnInit, OnDestroy {
  /** Show persistent header + footer (same routes) */
  showAppChrome = false;
  /** Home-style header vs back + logo + bell */
  shellHeaderLayout: 'main' | 'with-back' = 'main';

  private readonly destroy$ = new Subject<void>();

  private readonly shellBackRoutes = new Set([
    '/notifications',
    '/view-schedule',
    '/scheduling',
    '/qr-code',
    '/analytics',
    '/consent-letter',
    '/view-consent-letter',
  ]);

  constructor(
    private platform: Platform,
    private notificationService: NotificationService,
    private router: Router
  ) {
    this.refreshAppChrome(this.router.url);
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntil(this.destroy$)
      )
      .subscribe((e) => this.refreshAppChrome(e.urlAfterRedirects));
  }

  async ngOnInit() {
    await this.platform.ready();
    await this.initializeNotifications();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private refreshAppChrome(url: string): void {
    let path = (url.split('#')[0].split('?')[0] || '/').trim();
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    path = path.replace(/\/+$/, '') || '/';

    const hide =
      path === '/' ||
      path === '/home-screen' ||
      path === '/login' ||
      path === '/register' ||
      path === '/forgot-password';

    this.showAppChrome = !hide;
    this.shellHeaderLayout = !hide && this.shellBackRoutes.has(path) ? 'with-back' : 'main';
  }

  private async initializeNotifications() {
    try {
      await this.notificationService.initialize();
      console.log('✅ Notifications initialized in app component');
    } catch (error) {
      console.error('❌ Error initializing notifications in app component:', error);
    }
  }
}
