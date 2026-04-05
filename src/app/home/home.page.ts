import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, UserData } from '../services/auth';
import { AlertController, ToastController } from '@ionic/angular';
import { HttpClient } from '@angular/common/http';
import { FamilyService } from '../services/family.service';
import { RoleAccessService, UserRole } from '../services/role-access.service';
import { PanicService } from '../services/panic.service';
import { NotificationService } from '../services/notification.service';
import { Firestore, collection, query, where, getDocs, addDoc } from '@angular/fire/firestore';

interface WeatherData {
  weather: Array<{
    main: string;
    description: string;
    icon: string;
  }>;
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
  };
  name: string;
}

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: false
})
export class HomePage implements OnInit {
  currentUser: UserData | null = null;
  weatherData: WeatherData | null = null;
  upcomingPickups: any[] = [];
  userHasFamily: boolean = false;
  userRole: UserRole | null = null;

  private readonly WEATHER_API_KEY = '6549deb0d8bf8eb1d35194b5b7e02e43';

  constructor(
    private router: Router,
    private authService: AuthService,
    private alertController: AlertController,
    private toastController: ToastController,
    private http: HttpClient,
    private familyService: FamilyService,
    private roleAccessService: RoleAccessService,
    private firestore: Firestore,
    private panicService: PanicService,
    private notificationService: NotificationService
  ) { }

  async ngOnInit() {
    // Get current user data
    this.currentUser = this.authService.getCurrentUser();

    // Check if user has a family and get role
    if (this.currentUser) {
      this.userHasFamily = await this.familyService.checkUserHasFamily();
      this.userRole = await this.roleAccessService.getUserRole();
      console.log('User role loaded:', this.userRole); // Debug log to verify role detection
    }

    this.loadWeatherData();
    await this.loadUpcomingPickups();
  }

  private async loadUpcomingPickups() {
    try {
      if (!this.currentUser || !this.userHasFamily) return;

      // Get user's family
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      // Get current date in multiple formats for comparison
      const today = new Date();
      const todayString = today.toISOString().split('T')[0]; // YYYY-MM-DD format

      console.log('Today date for comparison:', todayString);

      // Query schedules for this family from today onwards
      const schedulesCollection = collection(this.firestore, 'Schedules');

      // First, get all schedules for this family
      const allSchedulesQuery = query(
        schedulesCollection,
        where('Family Name', '==', family.name)
      );

      console.log('Querying schedules for family:', family.name);

      const querySnapshot = await getDocs(allSchedulesQuery);

      this.upcomingPickups = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data() as any;

        // Check if the date is today or in the future and schedule is not completed
        const scheduleDate = new Date(data['Date']);
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Reset time to start of day
        const status = data['Status'] || 'pending';

        if (scheduleDate >= today && status !== 'completed') {
          this.upcomingPickups.push({
            id: doc.id,
            date: data['Date'] || '',
            time: data['Time'] || '',
            days: data['Days'] || '',
            fetcherName: data['Companions Name'] || '',
            childName: data['Childs Name'] || '',
            childGrade: data['Childs Grade'] || '',
            parentName: data['Parent Name'] || '',
            status: status
          });
        }
      });

      // Sort by date and get the nearest one
      this.upcomingPickups.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      console.log(`Loaded ${this.upcomingPickups.length} upcoming pickups for family: ${family.name}`);
      console.log('Upcoming pickups data:', this.upcomingPickups);

    } catch (error) {
      console.error('Error loading upcoming pickups:', error);
    }
  }

  private async loadWeatherData() {
    try {
      // Get user's location
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            this.fetchWeatherData(lat, lon);
          },
          (error) => {
            console.error('Error getting location:', error);
            // Fallback to a default location (Manila, Philippines)
            this.fetchWeatherData(14.5995, 120.9842);
          }
        );
      } else {
        // Fallback to a default location
        this.fetchWeatherData(14.5995, 120.9842);
      }
    } catch (error) {
      console.error('Error loading weather data:', error);
    }
  }

  private fetchWeatherData(lat: number, lon: number) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${this.WEATHER_API_KEY}&units=metric`;

    this.http.get<WeatherData>(url).subscribe({
      next: (data) => {
        this.weatherData = data;
      },
      error: (error) => {
        console.error('Error fetching weather data:', error);
      }
    });
  }

  getNextPickup() {
    return this.upcomingPickups.length > 0 ? this.upcomingPickups[0] : null;
  }

  formatPickupDate(dateString: string): string {
    const date = new Date(dateString);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return 'Tomorrow';
    } else {
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric'
      });
    }
  }

  getWeatherIcon(): string {
    if (!this.weatherData) return 'sunny';

    const weatherMain = this.weatherData.weather[0].main.toLowerCase();
    switch (weatherMain) {
      case 'clear':
        return 'sunny';
      case 'clouds':
        return 'cloudy';
      case 'rain':
        return 'rainy';
      case 'snow':
        return 'snow';
      case 'thunderstorm':
        return 'thunderstorm';
      default:
        return 'partly-sunny';
    }
  }

  getWeatherReminder(): string {
    if (!this.weatherData) return 'Have a great day!';

    const weatherMain = this.weatherData.weather[0].main.toLowerCase();
    const temp = this.weatherData.main.temp;

    switch (weatherMain) {
      case 'rain':
        return 'Don\'t forget your umbrella!';
      case 'snow':
        return 'Bundle up and stay warm!';
      case 'thunderstorm':
        return 'Stay safe and avoid outdoor activities!';
      case 'clouds':
        return 'Perfect weather for outdoor activities!';
      case 'clear':
        if (temp > 25) {
          return 'Stay hydrated and wear sunscreen!';
        } else if (temp < 15) {
          return 'Remember to bring a jacket!';
        } else {
          return 'Perfect weather for your trip!';
        }
      default:
        return 'Have a wonderful day!';
    }
  }

  // Navigation methods with family check
  async navigateToAnalytics() {
    if (await this.checkRoleAccess('analytics')) {
      this.router.navigate(['/analytics']);
    }
  }

  async navigateToDigitalConsent() {
    if (await this.checkRoleAccess('consent-letter')) {
      this.router.navigate(['/consent-letter']);
    }
  }

  async navigateToSetSchedule() {
    if (await this.checkRoleAccess('scheduling')) {
      this.router.navigate(['/scheduling']);
    }
  }

  async navigateToDisplayQR() {
    if (await this.checkRoleAccess('qr-code')) {
      this.router.navigate(['/qr-code']);
    }
  }

  async navigateToViewSchedule() {
    if (await this.checkRoleAccess('view-schedule')) {
      this.router.navigate(['/view-schedule']);
    }
  }

  async navigateToConsentLetter() {
    if (await this.checkRoleAccess('show-consent-letter')) {
      this.router.navigate(['/view-consent-letter']);
    }
  }

  /**
   * Check if user has family access and show alert if not
   */
  private async checkFamilyAccess(): Promise<boolean> {
    if (!this.currentUser) {
      await this.showAccessDeniedAlert('Please log in to access this feature.');
      return false;
    }

    const hasFamily = await this.familyService.checkUserHasFamily();
    if (!hasFamily) {
      await this.showAccessDeniedAlert('Please create a family first to access this feature.');
      return false;
    }

    return true;
  }

  private async checkRoleAccess(feature: string): Promise<boolean> {
    if (!this.currentUser) {
      await this.showAccessDeniedAlert('Please log in to access this feature.');
      return false;
    }

    const hasAccess = await this.roleAccessService.canUserAccess(feature);
    if (!hasAccess) {
      const userRoleString = await this.roleAccessService.getUserRoleString();
      const message = this.roleAccessService.getAccessDeniedMessage(feature, userRoleString);
      await this.showAccessDeniedAlert(message);
      return false;
    }

    return true;
  }

  /**
   * Show access denied alert with option to create family
   */
  private async showAccessDeniedAlert(message: string) {
    const alert = await this.alertController.create({
      header: 'Access Restricted',
      message: message,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Create Family',
          handler: async () => {
            // Check if user already has a family before navigating
            const hasFamily = await this.familyService.checkUserHasFamily();
            if (hasFamily) {
              this.router.navigate(['/created-family']);
            } else {
              this.router.navigate(['/register-create-family']);
            }
          }
        }
      ]
    });
    await alert.present();
  }

  navigateToHome() {
    // Already on home page - do nothing
  }

  async navigateToFamily() {
    // Check if user has created a family
    const hasFamily = await this.familyService.checkUserHasFamily();

    if (hasFamily) {
      // Navigate to created family page
      this.router.navigate(['/created-family']);
    } else {
      // Navigate to register/create family page
      // The FamilyGuard will handle the redirect if user already has a family
      this.router.navigate(['/register-create-family']);
    }
  }

  async navigateToMenu() {
    if (await this.checkFamilyAccess()) {
      this.router.navigate(['/notification-log']);
    }
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }

  navigateToNotifications() {
    this.router.navigate(['/notifications']);
  }

  navigateTo(route: string) {
    this.router.navigate([route]);
  }

  // Test method to create a sample schedule for debugging
  async createTestSchedule() {
    try {
      if (!this.currentUser) return;

      const family = await this.familyService.getUserFamily();
      if (!family) return;

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowString = tomorrow.toISOString().split('T')[0];

      const testSchedule = {
        'Childs Grade': 'Grade 5',
        'Childs Name': 'Test Child',
        'Companions Name': this.currentUser.fullName || 'Test Fetcher',
        'Date': tomorrowString,
        'Parent Name': this.currentUser.fullName || 'Test Parent',
        'Time': '3:00 PM',
        'Family Name': family.name,
        'Days': 'Tuesday',
        'Fetcher UID': this.currentUser.uid,
        'Creator UID': this.currentUser.uid,
        'Created At': new Date()
      };

      const schedulesCollection = collection(this.firestore, 'Schedules');
      await addDoc(schedulesCollection, testSchedule);

      console.log('Test schedule created successfully');
      await this.loadUpcomingPickups(); // Reload data

    } catch (error) {
      console.error('Error creating test schedule:', error);
    }
  }

  async triggerPanic() {
    await this.panicService.triggerPanicAlert();
  }

  async logout() {
    const alert = await this.alertController.create({
      header: 'Logout',
      message: 'Are you sure you want to logout?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Logout',
          handler: async () => {
            await this.authService.logout();
            this.router.navigate(['/home-screen']);
          }
        }
      ]
    });
    await alert.present();
  }

  // Test notification functionality (for development/testing)
  async testNotification() {
    try {
      await this.notificationService.sendTestNotification();

      const toast = await this.toastController.create({
        message: '🧪 Test notification sent! Check your notification tray.',
        duration: 3000,
        position: 'bottom',
        color: 'success'
      });
      await toast.present();
    } catch (error) {
      console.error('Error sending test notification:', error);

      const toast = await this.toastController.create({
        message: '❌ Error sending test notification',
        duration: 3000,
        position: 'bottom',
        color: 'danger'
      });
      await toast.present();
    }
  }
}
