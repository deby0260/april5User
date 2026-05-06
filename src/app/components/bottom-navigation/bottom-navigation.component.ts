import { Component, OnInit, OnDestroy } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { FamilyService } from '../../services/family.service';
import { PanicService } from '../../services/panic.service';
import { AuthService } from '../../services/auth';
import { Subject } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-bottom-navigation',
  templateUrl: './bottom-navigation.component.html',
  styleUrls: ['./bottom-navigation.component.scss'],
  standalone: false
})
export class BottomNavigationComponent implements OnInit, OnDestroy {
  userHasFamily: boolean = false;
  panicState: 'idle' | 'pressing' = 'idle';
  private destroy$ = new Subject<void>();

  constructor(
    private router: Router,
    private familyService: FamilyService,
    private panicService: PanicService,
    private authService: AuthService
  ) { }

  async ngOnInit() {
    const cached = this.familyService.getCachedUserHasFamily();
    if (cached !== null) {
      this.userHasFamily = cached;
    }

    this.familyService.userHasFamily$
      .pipe(takeUntil(this.destroy$))
      .subscribe((v) => {
        if (v !== null) {
          this.userHasFamily = v;
        }
      });

    void this.checkUserFamilyStatus();

    // Keep nav state consistent across route changes.
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        void this.checkUserFamilyStatus();
      });
  }

  async checkUserFamilyStatus() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        // Refresh cached family status in the background (avoids UI flicker).
        await this.familyService.checkUserHasFamily();
      } else {
        this.userHasFamily = false;
      }
    } catch (error) {
      this.userHasFamily = false;
    }
  }

  navigateToHome() {
    this.router.navigate(['/home']);
  }

  async navigateToFamily() {

    const hasFamily = await this.familyService.checkUserHasFamily();

    if (hasFamily) {

      this.router.navigate(['/created-family']);
    } else {

      this.router.navigate(['/register-create-family']);
    }
  }

  navigateToMenu() {
    this.router.navigate(['/notification-log']);
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }

  async triggerPanic() {
    if (this.panicState !== 'idle') return;
    
    this.panicState = 'pressing';
    this.triggerHapticFeedback();
    
    try {
      await this.panicService.triggerPanicAlert(
        () => this.onPanicAlertCancelled(),
        () => this.onPanicAlertConfirmed()
      );
    } catch (error) {
      this.panicState = 'idle';
    }
  }

  onPanicAlertConfirmed() {
    // Called when user confirms in the modal
    this.panicState = 'idle';
  }

  onPanicAlertCancelled() {
    // Called when user cancels in the modal
    this.panicState = 'idle';
  }

  onPanicMouseDown() {
    if (this.panicState === 'idle' && this.userHasFamily) {
      // Add visual feedback for press
      const button = document.querySelector('.panic-button');
      button?.classList.add('pressing');
    }
  }

  onPanicMouseUp() {
    const button = document.querySelector('.panic-button');
    button?.classList.remove('pressing');
  }

  getPanicButtonText(): string {
    switch (this.panicState) {
      case 'pressing':
        return 'Sending...';
      default:
        return 'Panic!';
    }
  }

  private triggerHapticFeedback() {
    // Haptic feedback for mobile devices
    if ((window as any).navigator?.vibrate) {
      (window as any).navigator.vibrate(50);
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  isCurrentRoute(route: string): boolean {
    const current = (this.router.url || '').split('?')[0];
    return current === route;
  }
}
