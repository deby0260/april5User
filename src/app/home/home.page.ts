import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, UserData } from '../services/auth';
import { AlertController } from '@ionic/angular';
import { HttpClient } from '@angular/common/http';
import { FamilyService } from '../services/family.service';
import { RoleAccessService, UserRole } from '../services/role-access.service';
import { PanicService } from '../services/panic.service';
import { NotificationService } from '../services/notification.service';
import { ScheduleExitScanSyncService } from '../services/schedule-exit-scan-sync.service';
import { OfflineCacheKeys, OfflineCacheService } from '../services/offline-cache.service';
import { Firestore, collection, query, where, getDocs } from '@angular/fire/firestore';

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

/** One logical pickup row (matches view-schedule merge of duplicate Firestore docs). */
interface HomePickupRow {
  id: string;
  date: string;
  time: string;
  days: string;
  fetcherName: string;
  childName: string;
  childGrade: string;
  parentName: string;
  status: string;
  createdAt: any;
  fetcherUID: string;
  duplicateDocIds?: string[];
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
  showingOfflinePickups = false;

  private readonly WEATHER_API_KEY = '6549deb0d8bf8eb1d35194b5b7e02e43';

  constructor(
    private router: Router,
    private authService: AuthService,
    private alertController: AlertController,
    private http: HttpClient,
    private familyService: FamilyService,
    private roleAccessService: RoleAccessService,
    private firestore: Firestore,
    private panicService: PanicService,
    private notificationService: NotificationService,
    private scheduleExitScanSync: ScheduleExitScanSyncService,
    private offlineCache: OfflineCacheService
  ) { }

  async ngOnInit() {
    // Get current user data
    this.currentUser = this.authService.getCurrentUser();

    // Check if user has a family and get role
    if (this.currentUser) {
      this.userHasFamily = await this.familyService.checkUserHasFamily();
      this.userRole = await this.roleAccessService.getUserRole();
    }

    this.loadWeatherData();
  }

  /** Reload pickups whenever Home is shown (tabs keep the page alive; avoids stale cards after edits). */
  async ionViewWillEnter() {
    await this.loadUpcomingPickups();
    void this.notificationService.syncPendingPickupReminders30mForCurrentUser({ force: false });
  }

  private toLocalYmd(dateStr: string): string {
    const parts = dateStr.split('-').map((n) => parseInt(n, 10));
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const [y, m, d] = parts;
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  /** Stored `Date` may be YYYY-MM-DD string or Firestore Timestamp — normalize to local calendar YMD. */
  private scheduleDateYmdFromFirestore(val: any): string {
    if (val == null) return '';
    if (typeof val === 'string') return this.toLocalYmd(val);
    if (typeof val.toDate === 'function') {
      const d = val.toDate();
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${day}`;
    }
    return '';
  }

  private parseTimeToMinutes(timeString: string): number {
    try {
      const raw = timeString.trim().split(/\s+/);
      const time = raw[0];
      const period = (raw[1] || '').toUpperCase();
      const [hours, minutes] = time.split(':').map(Number);
      let totalHours = hours;
      if (period === 'PM' && hours !== 12) totalHours += 12;
      else if (period === 'AM' && hours === 12) totalHours = 0;
      return totalHours * 60 + minutes;
    } catch {
      return 0;
    }
  }

  private parseScheduleTimeToMinutesSafe(timeString: string): number {
    if (!timeString) return 0;
    const t = timeString.trim();
    if (!t) return 0;
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const s = ampm[3] != null ? parseInt(ampm[3], 10) : 0;
      const ap = ampm[4].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return h * 60 + m + s / 60;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      const h = parseInt(h24[1], 10);
      const m = parseInt(h24[2], 10);
      const s = h24[3] != null ? parseInt(h24[3], 10) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(m)) return h * 60 + m + s / 60;
    }
    if (/\b(AM|PM)\b/i.test(t)) return this.parseTimeToMinutes(t);
    return 0;
  }

  private scheduleSortTimestamp(row: { date: string; time: string }): number {
    const parts = row.date.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;
    const [y, mo, d] = parts;
    const dayStart = new Date(y, mo - 1, d).getTime();
    return dayStart + this.parseScheduleTimeToMinutesSafe(row.time) * 60 * 1000;
  }

  private compareSchedulesChronologically(a: HomePickupRow, b: HomePickupRow): number {
    const ta = this.scheduleSortTimestamp(a);
    const tb = this.scheduleSortTimestamp(b);
    if (ta !== tb) return ta - tb;
    const minDiff =
      this.parseScheduleTimeToMinutesSafe(a.time) - this.parseScheduleTimeToMinutesSafe(b.time);
    if (minDiff !== 0) return minDiff;
    return String(a.time).localeCompare(String(b.time));
  }

  /**
   * "Upcoming Pickups" must hide any pending row whose scheduled date+time
   * has already elapsed. Without this, a missed pickup (status stays
   * `pending` because no exit scan closed it) shows up indefinitely as the
   * "Next Pickup" — see e.g. a Sunday 8:30 PM slot still showing on Monday
   * morning.
   *
   * Behaviour:
   *   - If we have both a parseable date and time → compare exact slot
   *     timestamp to `Date.now()`.
   *   - If we have a date but no parseable time → keep the row visible
   *     through the end of that calendar day (so a "no-time-set" entry
   *     doesn't vanish at midnight when it might still be valid).
   *   - If we can't parse the date at all → hide it (we can't sort or
   *     reason about it on the upcoming feed).
   */
  private isUpcomingPickupSlot(row: { date: string; time: string }): boolean {
    const ymd = this.toLocalYmd(row.date);
    if (!ymd) return false;
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return false;
    const [y, mo, d] = parts;

    const slot = new Date(y, mo - 1, d);
    slot.setHours(0, 0, 0, 0);

    const rawTime = String(row.time || '').trim();
    if (rawTime) {
      const minutes = this.parseScheduleTimeToMinutesSafe(rawTime);
      if (minutes > 0 || /^0?0?:00(?::\d{2})?\s*(AM)?$/i.test(rawTime)) {
        slot.setMinutes(minutes);
      } else {
        // Time string didn't parse cleanly — fall back to end-of-day so a
        // weird value doesn't silently hide a same-day pickup.
        slot.setHours(23, 59, 59, 999);
      }
    } else {
      slot.setHours(23, 59, 59, 999);
    }

    return slot.getTime() >= Date.now();
  }

  private createdAtMs(v: any): number {
    if (v == null) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    return 0;
  }

  private scheduleDedupeKey(s: HomePickupRow): string {
    return `${this.toLocalYmd(s.date)}|${String(s.time || '').trim()}|${String(s.childName || '').trim()}|${s.fetcherUID || ''}|${String(s.days || '').trim()}`;
  }

  /** Same grouping as view-schedule so "Next pickup" matches the first row there (and deletes remove all merged ids). */
  private mergeDuplicatePickups(items: HomePickupRow[]): HomePickupRow[] {
    const groups = new Map<string, HomePickupRow[]>();
    for (const s of items) {
      const k = this.scheduleDedupeKey(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    const out: HomePickupRow[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        out.push(group[0]);
        continue;
      }
      group.sort((a, b) => this.createdAtMs(b.createdAt) - this.createdAtMs(a.createdAt));
      const [primary, ...rest] = group;
      out.push({
        ...primary,
        duplicateDocIds: rest.map((r) => r.id),
      });
    }
    return out;
  }

  private async loadUpcomingPickups() {
    try {
      this.currentUser = this.authService.getCurrentUser();
      if (!this.currentUser) {
        this.upcomingPickups = [];
        this.showingOfflinePickups = false;
        return;
      }
      if (!this.userHasFamily) {
        this.userHasFamily = await this.familyService.checkUserHasFamily();
      }
      if (!this.userHasFamily) {
        this.upcomingPickups = [];
        this.showingOfflinePickups = false;
        return;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        const cached = this.offlineCache.load<any[]>(OfflineCacheKeys.homePickups(''));
        if (cached?.length) {
          this.upcomingPickups = cached;
          this.showingOfflinePickups = true;
          this.offlineCache.setBannerActive(true);
        } else {
          this.upcomingPickups = [];
          this.showingOfflinePickups = false;
        }
        return;
      }

      const cacheKey = OfflineCacheKeys.homePickups(family.name);
      const result = await this.offlineCache.loadWithOfflineFallback(cacheKey, async () => {
        if (this.offlineCache.isOnline()) {
          await this.scheduleExitScanSync.syncExitScansToCompletedSchedules(family.name);
        }
        return this.fetchUpcomingPickupsForFamily(family.name);
      });
      this.upcomingPickups = result.data;
      this.showingOfflinePickups = result.fromCache;
    } catch {
      this.upcomingPickups = [];
      this.showingOfflinePickups = false;
    }
  }

  private async fetchUpcomingPickupsForFamily(familyName: string): Promise<any[]> {
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const allSchedulesQuery = query(
      schedulesCollection,
      where('Family Name', '==', familyName)
    );

    const querySnapshot = await getDocs(allSchedulesQuery);
    const pending: HomePickupRow[] = [];

    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const status = data['Status'] || 'pending';
      if (status !== 'pending') return;

      const dateYmd = this.scheduleDateYmdFromFirestore(data['Date']);
      pending.push({
        id: docSnap.id,
        date: dateYmd || String(data['Date'] || ''),
        time: data['Time'] || '',
        days: data['Days'] || '',
        fetcherName: data['Companions Name'] || '',
        childName: data['Childs Name'] || '',
        childGrade: data['Childs Grade'] || '',
        parentName: data['Parent Name'] || '',
        status,
        createdAt: data['Created At'],
        fetcherUID: String(data['Fetcher UID'] || ''),
      });
    });

    const merged = this.mergeDuplicatePickups(pending);
    const upcomingOnly = merged.filter((row) => this.isUpcomingPickupSlot(row));
    upcomingOnly.sort((a, b) => this.compareSchedulesChronologically(a, b));

    return upcomingOnly.map((row) => ({
      id: row.id,
      date: row.date,
      time: row.time,
      days: row.days,
      fetcherName: row.fetcherName,
      childName: row.childName,
      childGrade: row.childGrade,
      parentName: row.parentName,
      status: row.status,
    }));
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
            // Fallback to a default location (Manila, Philippines)
            this.fetchWeatherData(14.5995, 120.9842);
          }
        );
      } else {
        // Fallback to a default location
        this.fetchWeatherData(14.5995, 120.9842);
      }
    } catch (error) {
    }
  }

  private fetchWeatherData(lat: number, lon: number) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${this.WEATHER_API_KEY}&units=metric`;

    this.http.get<WeatherData>(url).subscribe({
      next: (data) => {
        this.weatherData = data;
      },
      error: (error) => {
      }
    });
  }

  getNextPickup() {
    return this.upcomingPickups.length > 0 ? this.upcomingPickups[0] : null;
  }

  /** 12-hour display for schedule times (handles HH:mm / HH:mm:ss from ion-input and h:mm AM/PM). */
  formatPickupTime(timeString: string): string {
    if (!timeString?.trim()) return '';
    const t = timeString.trim();
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = ampm[2].padStart(2, '0');
      const ap = ampm[3].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      const h12 = h % 12 || 12;
      return `${h12}:${m} ${ap}`;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      let h = parseInt(h24[1], 10);
      const m = h24[2].padStart(2, '0');
      if (h > 23 || h < 0) return timeString;
      const ap = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${m} ${ap}`;
    }
    return timeString;
  }

  formatPickupDate(dateString: string): string {
    const parts = dateString.split('-').map((n) => parseInt(n, 10));
    const date =
      parts.length === 3 && !parts.some(Number.isNaN)
        ? new Date(parts[0], parts[1] - 1, parts[2])
        : new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (d0.getTime() === today.getTime()) return 'Today';
    if (d0.getTime() === tomorrow.getTime()) return 'Tomorrow';
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
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
      await this.showAccessDeniedAlert('Please log in to access this feature.', false);
      return false;
    }

    const hasFamily = await this.familyService.checkUserHasFamily();
    if (!hasFamily) {
      await this.showAccessDeniedAlert('Please create a family first to access this feature.', true);
      return false;
    }

    return true;
  }

  private async checkRoleAccess(feature: string): Promise<boolean> {
    if (!this.currentUser) {
      await this.showAccessDeniedAlert('Please log in to access this feature.', false);
      return false;
    }

    const hasAccess = await this.roleAccessService.canUserAccess(feature);
    if (!hasAccess) {
      await this.showAccessDeniedAlert('', false);
      return false;
    }

    return true;
  }

  /**
   * Access denied alert. Empty message = header only. Create Family only when no family yet.
   */
  private async showAccessDeniedAlert(message: string, includeCreateFamily = false) {
    const buttons: {
      text: string;
      role?: string;
      handler?: () => void | Promise<void>;
    }[] = [{ text: 'Cancel', role: 'cancel' }];

    if (includeCreateFamily) {
      buttons.push({
        text: 'Create Family',
        handler: async () => {
          const hasFamily = await this.familyService.checkUserHasFamily();
          if (hasFamily) {
            this.router.navigate(['/created-family']);
          } else {
            this.router.navigate(['/register-create-family']);
          }
        },
      });
    }

    const alert = await this.alertController.create({
      header: 'Access Restricted',
      ...(message.trim() ? { message } : {}),
      buttons,
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

  navigateTo(route: string) {
    this.router.navigate([route]);
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
}
