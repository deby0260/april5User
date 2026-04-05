import { Component, OnInit } from '@angular/core';
import { Platform } from '@ionic/angular';
import { NotificationService } from './services/notification.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent implements OnInit {
  constructor(
    private platform: Platform,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.platform.ready();
    await this.initializeNotifications();
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
