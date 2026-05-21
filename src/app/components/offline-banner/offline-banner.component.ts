import { Component } from '@angular/core';
import { OfflineCacheService } from '../../services/offline-cache.service';

@Component({
  selector: 'app-offline-banner',
  templateUrl: './offline-banner.component.html',
  styleUrls: ['./offline-banner.component.scss'],
  standalone: false,
})
export class OfflineBannerComponent {
  constructor(public offlineCache: OfflineCacheService) {}
}
