import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Firestore, collection, query, where, getDocs } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';

interface ConsentLetterData {
  letter: string;
  signature: string;
  emergencyFetcher: boolean;
  oneTimeFetcher: boolean;
  dateIssued: any;
  validUntil: string;
  parentName: string;
  familyName: string;
  uid: string;
  /** Set by the new consent-letter form. Drives access control. */
  authorizedFetcherUid: string;
  authorizedFetcherName: string;
  childName: string;
  /** YYYY-MM-DD this consent applies to. */
  consentDate: string;
  id?: string;
}

@Component({
  selector: 'app-view-consent-letter',
  templateUrl: './view-consent-letter.page.html',
  styleUrls: ['./view-consent-letter.page.scss'],
  standalone: false
})
export class ViewConsentLetterPage implements OnInit {
  consentLetters: ConsentLetterData[] = [];
  selectedLetter: ConsentLetterData | null = null;
  /**
   * Drives the in-page loading section in the template. The previous
   * implementation also opened a separate `LoadingController` modal, which
   * stacked a second spinner on top of the page-level one — that has been
   * removed; only this flag remains.
   */
  isLoading = false;

  constructor(
    private location: Location,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
  ) { }

  ngOnInit() {
    void this.loadConsentLetters();
  }

  /**
   * Loads ONLY consent letters where the current user is the authorized
   * fetcher (`authorizedFetcherUid === currentUser.uid`). Letters created
   * before this field existed are intentionally hidden because we have no
   * way to verify they were meant for this user.
   */
  async loadConsentLetters(): Promise<void> {
    this.isLoading = true;
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser?.uid) {
        this.consentLetters = [];
        this.selectedLetter = null;
        return;
      }

      // The viewer is fetcher-scoped. We query Firestore directly by
      // `authorizedFetcherUid` so other family members never even read
      // these docs (and unrelated reads stay light on quota).
      const consentCollection = collection(this.firestore, 'Consent Letters');
      const myLettersQuery = query(
        consentCollection,
        where('authorizedFetcherUid', '==', currentUser.uid),
      );
      const snap = await getDocs(myLettersQuery);

      const family = await this.familyService.getUserFamily();
      const familyName = family?.name || '';

      const letters: ConsentLetterData[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Record<string, any>;
        // Belt-and-suspenders: even if Firestore returns something odd, we
        // never surface a letter that doesn't actually authorize this user.
        const fetcherUid = String(data['authorizedFetcherUid'] || '').trim();
        if (!fetcherUid || fetcherUid !== currentUser.uid) {
          return;
        }
        letters.push({
          id: docSnap.id,
          letter: data['letter'] || '',
          signature: data['signature'] || '',
          emergencyFetcher: !!data['emergencyFetcher'],
          oneTimeFetcher: !!data['oneTimeFetcher'],
          dateIssued: data['dateIssued'],
          validUntil: data['validUntil'] || 'Today Only',
          parentName: data['parentName'] || 'Parent',
          familyName: data['familyName'] || familyName,
          uid: data['uid'] || '',
          authorizedFetcherUid: fetcherUid,
          authorizedFetcherName: data['authorizedFetcherName'] || '',
          childName: data['childName'] || '',
          consentDate: data['consentDate'] || '',
        });
      });

      letters.sort((a, b) => {
        const ta = this.timestampMs(a.dateIssued);
        const tb = this.timestampMs(b.dateIssued);
        return tb - ta;
      });

      this.consentLetters = letters;
      this.selectedLetter = letters.length > 0 ? letters[0] : null;
    } catch {
      this.consentLetters = [];
      this.selectedLetter = null;
    } finally {
      this.isLoading = false;
    }
  }

  /** Converts a Firestore Timestamp / Date / string into a millisecond value for sorting. */
  private timestampMs(val: any): number {
    if (!val) return 0;
    try {
      if (typeof val.toMillis === 'function') return val.toMillis();
      if (typeof val.toDate === 'function') return val.toDate().getTime();
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    } catch {
      return 0;
    }
  }

  /** Formats the stored consent date YYYY-MM-DD for display. */
  formatConsentDate(ymd: string): string {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  selectLetter(letter: ConsentLetterData): void {
    this.selectedLetter = letter;
  }

  goBack(): void {
    this.location.back();
  }
}
