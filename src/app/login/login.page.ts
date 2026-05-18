import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Location } from '@angular/common';
import { AuthService } from '../services/auth';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';
import { NotificationFeedsBackgroundService } from '../services/notification-feeds-background.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false
})
export class LoginPage implements OnInit {
  email: string = '';
  password: string = '';
  /** Toggle between masked and visible password */
  showPassword = false;

  isLoading: boolean = false;

  constructor(
    private router: Router,
    private location: Location,
    private authService: AuthService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController,
    private notificationFeedsBackground: NotificationFeedsBackgroundService
  ) { }

  ngOnInit() {
  }

  togglePasswordVisibility(ev?: Event): void {
    ev?.stopPropagation();
    this.showPassword = !this.showPassword;
  }

  async login() {
    if (!this.validateForm()) {
      return;
    }


    const loading = await this.loadingController.create({
      message: 'Signing in...',
      spinner: 'crescent'
    });
    await loading.present();

    try {
      const result = await this.authService.loginUser(this.email, this.password);

      await loading.dismiss();

      if (result.success) {

        await this.showToast('Login successful!', 'success');

        void this.notificationFeedsBackground.ensureRunning();

        this.router.navigate(['/home']);
      } else {

        await this.showAlert('Login Failed', result.message);
      }
    } catch (error: any) {
      await loading.dismiss();
      await this.showAlert('Login Failed', 'An unexpected error occurred. Please try again.');
    }
  }

  private validateForm(): boolean {
    if (!this.email || !this.password) {
      this.showAlert('Validation Error', 'Please enter both email and password.');
      return false;
    }


    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(this.email)) {
      this.showAlert('Validation Error', 'Please enter a valid email address.');
      return false;
    }

    return true;
  }

  private async showAlert(header: string, message: string): Promise<void> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK']
    });
    await alert.present();
  }

  private async showToast(message: string, color: string = 'primary'): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      color,
      position: 'top'
    });
    await toast.present();
  }

  goToRegister() {
    this.router.navigate(['/register']);
  }

  goToForgotPassword(event?: Event) {
    event?.preventDefault();
    this.router.navigate(['/forgot-password']);
  }
}
