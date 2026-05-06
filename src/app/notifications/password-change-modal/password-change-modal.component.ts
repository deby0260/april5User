import { Component, Input } from '@angular/core';
import { ModalController, ToastController, LoadingController } from '@ionic/angular';
import { PasswordChangeService } from '../../services/password-change.service';

@Component({
  selector: 'app-password-change-modal',
  templateUrl: './password-change-modal.component.html',
  styleUrls: ['./password-change-modal.component.scss'],
  standalone: false
})
export class PasswordChangeModalComponent {
  @Input() notificationId: string = '';
  @Input() passwordAlreadyChanged: boolean = false;
  
  newPassword: string = '';
  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;
  isSubmitting: boolean = false;

  constructor(
    private modalController: ModalController,
    private passwordChangeService: PasswordChangeService,
    private toastController: ToastController,
    private loadingController: LoadingController
  ) { }

  /**
   * Toggle password visibility
   */
  togglePasswordVisibility() {
    this.showPassword = !this.showPassword;
  }

  /**
   * Toggle confirm password visibility
   */
  toggleConfirmPasswordVisibility() {
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  /**
   * Validate password inputs
   */
  validatePasswords(): { valid: boolean; message: string } {
    if (!this.newPassword || !this.confirmPassword) {
      return { valid: false, message: 'Please fill in all fields' };
    }

    if (this.newPassword.length < 6) {
      return { valid: false, message: 'Password must be at least 6 characters' };
    }

    if (this.newPassword !== this.confirmPassword) {
      return { valid: false, message: 'Passwords do not match' };
    }

    return { valid: true, message: '' };
  }

  /**
   * Submit password change
   */
  async submitPasswordChange() {
    // Check if password was already changed
    if (this.passwordAlreadyChanged) {
      await this.showToast('Password has already been changed. You cannot change it again.', 'warning');
      this.closeModal(false);
      return;
    }

    const validation = this.validatePasswords();
    if (!validation.valid) {
      await this.showToast(validation.message, 'warning');
      return;
    }

    const loading = await this.loadingController.create({
      message: 'Changing password...'
    });
    await loading.present();

    try {
      this.isSubmitting = true;

      // Change password
      const result = await this.passwordChangeService.changePassword(this.newPassword);
      if (!result.success) {
        await this.showToast(result.message, 'danger');
        await loading.dismiss();
        return;
      }

      // Mark notification as completed
      if (this.notificationId) {
        await this.passwordChangeService.markPasswordChangeAsCompleted(this.notificationId);
      }

      await this.showToast('Password changed successfully!', 'success');
      await loading.dismiss();

      // Close modal after a short delay
      setTimeout(() => {
        this.closeModal(true);
      }, 1000);
    } catch (error) {
      await this.showToast('An error occurred while changing password', 'danger');
    } finally {
      this.isSubmitting = false;
      await loading.dismiss();
    }
  }

  /**
   * Close modal
   */
  async closeModal(success: boolean = false) {
    await this.modalController.dismiss({
      dismissed: true,
      success: success
    });
  }

  /**
   * Show toast message
   */
  private async showToast(message: string, color: string = 'primary') {
    const toast = await this.toastController.create({
      message: message,
      duration: 2000,
      position: 'bottom',
      color: color
    });
    await toast.present();
  }
}
