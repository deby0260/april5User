import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { FamilyService } from '../../services/family.service';
import { PanicService } from '../../services/panic.service';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-bottom-navigation',
  templateUrl: './bottom-navigation.component.html',
  styleUrls: ['./bottom-navigation.component.scss'],
  standalone: false
})
export class BottomNavigationComponent implements OnInit, OnDestroy {
  userHasFamily: boolean = false;
  panicState: 'idle' | 'pressing' = 'idle';

  constructor(
    private router: Router,
    private familyService: FamilyService,
    private panicService: PanicService,
    private authService: AuthService
  ) { }

  async ngOnInit() {
    await this.checkUserFamilyStatus();
  }

  async checkUserFamilyStatus() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        this.userHasFamily = await this.familyService.checkUserHasFamily();
      }
    } catch (error) {
      console.error('Error checking family status:', error);
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
    
    console.log('🚨 Panic button clicked!');
    this.panicState = 'pressing';
    this.triggerHapticFeedback();
    
    try {
      await this.panicService.triggerPanicAlert(
        () => this.onPanicAlertCancelled(),
        () => this.onPanicAlertConfirmed()
      );
    } catch (error) {
      console.error('Error showing panic alert modal:', error);
      this.panicState = 'idle';
    }
  }

  onPanicAlertConfirmed() {
    // Called when user confirms in the modal
    console.log('✅ Panic alert confirmed');
    this.panicState = 'idle';
  }

  onPanicAlertCancelled() {
    // Called when user cancels in the modal
    console.log('❌ Panic alert cancelled');
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
    // Cleanup if needed
  }

  isCurrentRoute(route: string): boolean {
    return this.router.url === route;
  }
}
