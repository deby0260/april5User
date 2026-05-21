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
   * Loads letters the user may view:
   * - Parent/owner who created the letter (`uid`)
   * - Companion who was authorized (`authorizedFetcherUid`)
   * Both queries run so the correct list appears regardless of role label.
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

      const uid = currentUser.uid;
      const consentCollection = collection(this.firestore, 'Consent Letters');

      const [authorSnap, fetcherSnap] = await Promise.all([
        getDocs(query(consentCollection, where('uid', '==', uid))),
        getDocs(query(consentCollection, where('authorizedFetcherUid', '==', uid))),
      ]);

      const family = await this.familyService.getUserFamily();
      const familyName = family?.name || '';

      const byId = new Map<string, ConsentLetterData>();

      const ingest = (docSnap: { id: string; data: () => Record<string, unknown> }) => {
        const data = docSnap.data() as Record<string, any>;
        const authorUid = String(data['uid'] || '').trim();
        const fetcherUid = String(data['authorizedFetcherUid'] || '').trim();

        const isAuthor = authorUid === uid;
        const isAuthorizedFetcher = fetcherUid === uid;
        if (!isAuthor && !isAuthorizedFetcher) {
          return;
        }

        byId.set(docSnap.id, {
          id: docSnap.id,
          letter: data['letter'] || '',
          signature: data['signature'] || '',
          emergencyFetcher: !!data['emergencyFetcher'],
          oneTimeFetcher: !!data['oneTimeFetcher'],
          dateIssued: data['dateIssued'],
          validUntil: data['validUntil'] || 'Today Only',
          parentName: data['parentName'] || 'Parent',
          familyName: data['familyName'] || familyName,
          uid: authorUid,
          authorizedFetcherUid: fetcherUid,
          authorizedFetcherName: data['authorizedFetcherName'] || '',
          childName: data['childName'] || '',
          consentDate: data['consentDate'] || '',
        });
      };

      authorSnap.forEach(ingest);
      fetcherSnap.forEach(ingest);

      const letters = Array.from(byId.values()).sort((a, b) => {
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
