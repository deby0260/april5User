import { Component } from '@angular/core';
import { combineLatest, map } from 'rxjs';
import { OfflineCacheService } from '../../services/offline-cache.service';

@Component({
  selector: 'app-offline-banner',
  templateUrl: './offline-banner.component.html',
  styleUrls: ['./offline-banner.component.scss'],
  standalone: false,
})
export class OfflineBannerComponent {
  readonly bannerState$ = combineLatest([
    this.offlineCache.offlineMode$,
    this.offlineCache.bannerActive$,
  ]).pipe(
    map(([offline, cached]) => ({
      offline: !!offline,
      cached: !!cached,
      visible: !!offline || !!cached,
    }))
  );

  constructor(public offlineCache: OfflineCacheService) {}
}
