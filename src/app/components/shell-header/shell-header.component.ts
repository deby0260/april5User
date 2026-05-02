import { Component, Input } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

@Component({
  selector: 'app-shell-header',
  templateUrl: './shell-header.component.html',
  styleUrls: ['./shell-header.component.scss'],
  standalone: false,
})
export class ShellHeaderComponent {
  /** Home-style bar, or sub-page with back + logo + bell */
  @Input() layout: 'main' | 'with-back' = 'main';

  constructor(
    private location: Location,
    private router: Router
  ) {}

  goBack(): void {
    this.location.back();
  }

  navigateToNotifications(): void {
    void this.router.navigate(['/notifications']);
  }
}
