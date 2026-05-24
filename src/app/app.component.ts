import { Component, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Platform } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { Subject } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { NotificationService } from './services/notification.service';
import { AuthService, UserData } from './services/auth';
import { NotificationFeedsBackgroundService } from './services/notification-feeds-background.service';
import { RoleAccessService } from './services/role-access.service';

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
    private authService: AuthService,
    private notificationFeedsBackground: NotificationFeedsBackgroundService,
    private roleAccessService: RoleAccessService,
    private router: Router
  ) {
    this.refreshAppChrome(this.router.url);
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntil(this.destroy$)
      )
      .subscribe((e) => {
        this.refreshAppChrome(e.urlAfterRedirects);
      });
  }

  async ngOnInit() {
    await this.platform.ready();
    this.authService.ensureSessionRestored();
    this.redirectToSavedSessionIfNeeded();
    await this.dismissAppSplash();
    await this.initializeNotifications();
    this.authService.currentUser$
      .pipe(takeUntil(this.destroy$))
      .subscribe((user: UserData | null) => {
        if (user?.uid) {
          void this.notificationFeedsBackground.ensureRunning();
          void this.notificationService.syncPushTokenAfterLogin();
          void this.roleAccessService.warmUserRoleCache();
        } else {
          this.notificationFeedsBackground.stop();
        }
      });
    if (this.authService.getCurrentUser()?.uid) {
      void this.notificationFeedsBackground.ensureRunning();
      void this.notificationService.syncPushTokenAfterLogin();
      void this.roleAccessService.warmUserRoleCache();
    }

    if (Capacitor.isNativePlatform()) {
      CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          this.authService.ensureSessionRestored();
          this.redirectToSavedSessionIfNeeded();
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** If user force-closed the app, skip welcome/login and open the main app. */
  private redirectToSavedSessionIfNeeded(): void {
    if (!this.authService.isLoggedIn()) {
      return;
    }
    const path = (this.router.url.split('?')[0] || '/').replace(/\/+$/, '') || '/';
    const guestOnly =
      path === '/' ||
      path === '/home-screen' ||
      path === '/login' ||
      path === '/register' ||
      path === '/forgot-password';
    if (guestOnly) {
      void this.router.navigateByUrl('/home', { replaceUrl: true });
    }
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
      path === '/forgot-password' ||
      path === '/reset-password';

    this.showAppChrome = !hide;
    this.shellHeaderLayout = !hide && this.shellBackRoutes.has(path) ? 'with-back' : 'main';
  }

  private async dismissAppSplash(): Promise<void> {
    try {
      await SplashScreen.hide();
    } catch {
      /* Web / browser — plugin optional */
    }
    document.getElementById('bootstrap-splash')?.classList.add('hidden');
  }

  private async initializeNotifications() {
    try {
      await this.notificationService.initialize();
    } catch (error) {
    }
  }
}
