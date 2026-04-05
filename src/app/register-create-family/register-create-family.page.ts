import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, getDocs, query, where } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { JoinRequestService, JoinRequest } from '../services/join-request.service';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';

interface Family {
  id: string;
  name: string;
  photo?: string;
  memberCount: number;
  createdBy: string;
  dateCreated: any;
}

@Component({
  selector: 'app-register-create-family',
  templateUrl: './register-create-family.page.html',
  styleUrls: ['./register-create-family.page.scss'],
  standalone: false
})
export class RegisterCreateFamilyPage implements OnInit {
  searchTerm: string = '';
  searchResults: Family[] = [];
  allFamilies: Family[] = [];
  isLoading: boolean = false;
  pendingRequests: JoinRequest[] = [];
  hasPendingRequest: boolean = false;

  constructor(
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private joinRequestService: JoinRequestService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController
  ) {}

  async ngOnInit() {
    await this.checkIfUserHasFamily();
    await this.loadPendingRequests();
    await this.loadAllFamilies();
  }

  async ionViewWillEnter() {
    await this.checkIfUserHasFamily();
  }

  private pick<T = any>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && v !== '') return v as T;
    }
    return undefined;
  }

  private toJsDate(v: any): Date | null {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  private normalizeText(s: string): string {
    // lowercase + remove accents/diacritics for tolerant searching
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  async checkIfUserHasFamily() {
    try {
      const hasFamily = await this.familyService.checkUserHasFamily();
      if (hasFamily) {
        this.router.navigate(['/created-family'], { replaceUrl: true });
        return;
      }
    } catch (error) {
      console.error('Error checking user family status:', error);
    }
  }

  async loadPendingRequests() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        this.pendingRequests = await this.joinRequestService.getUserPendingRequests(currentUser.uid);
        this.hasPendingRequest = this.pendingRequests.length > 0;
      }
    } catch (error) {
      console.error('Error loading pending requests:', error);
    }
  }

  async loadAllFamilies() {
    try {
      this.isLoading = true;

      const familiesCollection = collection(this.firestore, 'List Of Families');
      const snapshot = await getDocs(familiesCollection);

      // Merge docs by family name (support both "Family Name" and "familyName")
      const familyMap = new Map<string, Family>();

      snapshot.docs.forEach(doc => {
        const data = doc.data();

        const name =
          this.pick<string>(data, 'Family Name', 'familyName');  // <-- key fix
        if (!name) return;

        const createdBy = this.pick<string>(data, 'uid') || '';
        const dateCreated = this.pick<any>(data, 'Date Created', 'dateCreated') || null;

        // Prefer parent photo, fall back to child photo
        const photo =
          this.pick<string>(data, 'parentProfilePicture', 'Parent Profile Picture') ||
          this.pick<string>(data, 'childProfilePicture', 'Child Profile Picture') ||
          undefined;

        const key = name;

        if (!familyMap.has(key)) {
          familyMap.set(key, {
            id: doc.id,
            name,
            createdBy,
            dateCreated,
            memberCount: 1,
            photo
          });
        } else {
          // If multiple docs exist for same family (e.g., multiple children), update counters / enrich fields
          const existing = familyMap.get(key)!;
          existing.memberCount = (existing.memberCount || 0) + 1;
          if (!existing.photo && photo) existing.photo = photo;

          // Earliest creation date (if some docs have older timestamps)
          const currentDate = this.toJsDate(existing.dateCreated);
          const candidateDate = this.toJsDate(dateCreated);
          if (candidateDate && (!currentDate || candidateDate < currentDate)) {
            existing.dateCreated = dateCreated;
          }

          // Prefer a real creator uid if missing
          if (!existing.createdBy && createdBy) existing.createdBy = createdBy;

          familyMap.set(key, existing);
        }
      });

      // Convert to array and sort alphabetically
      this.allFamilies = Array.from(familyMap.values())
        .sort((a, b) => a.name.localeCompare(b.name));

      // Reset results for current term, if any
      if (this.searchTerm) {
        this.onSearchInput({ target: { value: this.searchTerm } });
      }

    } catch (error) {
      console.error('Error loading families:', error);
      this.showToast('Error loading families. Please try again.');
    } finally {
      this.isLoading = false;
    }
  }

  async onSearchInput(event: any) {
    const raw = (event?.target?.value ?? '').toString();
    this.searchTerm = raw;

    const q = this.normalizeText(raw.trim());

    if (!q) {
      this.searchResults = [];
      return;
    }

    // First try client-side filtering from loaded families
    this.searchResults = this.allFamilies.filter(family =>
      this.normalizeText(family.name).includes(q)
    );

    // If no results from loaded families, try server-side search
    if (this.searchResults.length === 0) {
      await this.searchFamiliesInDatabase(raw.trim());
    }
  }

  private async searchFamiliesInDatabase(searchTerm: string) {
    try {
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Search by "Family Name" field
      const q1 = query(familiesCollection, where('Family Name', '>=', searchTerm), where('Family Name', '<=', searchTerm + '\uf8ff'));
      const snapshot1 = await getDocs(q1);

      // Also search by "familyName" field (alternative field name)
      const q2 = query(familiesCollection, where('familyName', '>=', searchTerm), where('familyName', '<=', searchTerm + '\uf8ff'));
      const snapshot2 = await getDocs(q2);

      const familyMap = new Map<string, Family>();

      // Process results from both queries
      [snapshot1, snapshot2].forEach(snapshot => {
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          const name = this.pick<string>(data, 'Family Name', 'familyName');
          if (!name) return;

          const createdBy = this.pick<string>(data, 'uid') || '';
          const dateCreated = this.pick<any>(data, 'Date Created', 'dateCreated') || null;
          const photo =
            this.pick<string>(data, 'parentProfilePicture', 'Parent Profile Picture') ||
            this.pick<string>(data, 'childProfilePicture', 'Child Profile Picture') ||
            undefined;

          const key = name;

          if (!familyMap.has(key)) {
            familyMap.set(key, {
              id: doc.id,
              name,
              createdBy,
              dateCreated,
              memberCount: 1,
              photo
            });
          } else {
            const existing = familyMap.get(key)!;
            existing.memberCount = (existing.memberCount || 0) + 1;
            if (!existing.photo && photo) existing.photo = photo;

            const currentDate = this.toJsDate(existing.dateCreated);
            const candidateDate = this.toJsDate(dateCreated);
            if (candidateDate && (!currentDate || candidateDate < currentDate)) {
              existing.dateCreated = dateCreated;
            }

            if (!existing.createdBy && createdBy) existing.createdBy = createdBy;
            familyMap.set(key, existing);
          }
        });
      });

      this.searchResults = Array.from(familyMap.values())
        .sort((a, b) => a.name.localeCompare(b.name));

    } catch (error) {
      console.error('Error searching families in database:', error);
      // Silently fail - results will just be empty
    }
  }

  async selectFamily(family: Family) {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.showToast('Please log in to join a family');
      return;
    }

    const hasExistingRequest = await this.joinRequestService.checkExistingRequest(currentUser.uid, family.name);
    if (hasExistingRequest) {
      this.showToast('You already have a pending request for this family');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Request to Join Family',
      message: `Send a join request to "${family.name}"? The family owner will need to approve your request.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Send Request',
          handler: async () => {
            await this.sendJoinRequest(family);
          }
        }
      ]
    });

    await alert.present();
  }

  async sendJoinRequest(family: Family) {
    try {
      const loading = await this.loadingController.create({ message: 'Sending join request...' });
      await loading.present();

      const result = await this.joinRequestService.createJoinRequest(family.name, family.createdBy);

      await loading.dismiss();

      if (result.success) {
        this.showToast(result.message);
        await this.loadPendingRequests();
      } else {
        this.showToast(result.message);
      }
    } catch (error) {
      console.error('Error sending join request:', error);
      this.showToast('Error sending join request. Please try again.');
    }
  }

  async cancelJoinRequest(request: JoinRequest) {
    const alert = await this.alertController.create({
      header: 'Cancel Join Request',
      message: `Cancel your join request for "${request.familyName}"?`,
      buttons: [
        { text: 'No', role: 'cancel' },
        {
          text: 'Yes, Cancel',
          handler: async () => {
            if (request.id) {
              const result = await this.joinRequestService.cancelJoinRequest(request.id);
              if (result.success) {
                this.showToast(result.message);
                await this.loadPendingRequests();
              } else {
                this.showToast(result.message);
              }
            }
          }
        }
      ]
    });

    await alert.present();
  }

  navigateToNotifications() {
    this.router.navigate(['/notification-log']);
  }

  formatDate(dateValue: any): string {
    if (!dateValue) return 'Unknown';

    try {
      let date: Date;

      // Handle Firestore Timestamp
      if (dateValue && typeof dateValue.toDate === 'function') {
        date = dateValue.toDate();
      } else if (dateValue instanceof Date) {
        date = dateValue;
      } else if (typeof dateValue === 'string') {
        date = new Date(dateValue);
      } else if (typeof dateValue === 'number') {
        date = new Date(dateValue);
      } else {
        return 'Unknown';
      }

      // Format the date
      if (isNaN(date.getTime())) {
        return 'Unknown';
      }

      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      console.error('Error formatting date:', error);
      return 'Unknown';
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      position: 'bottom'
    });
    await toast.present();
  }
}
