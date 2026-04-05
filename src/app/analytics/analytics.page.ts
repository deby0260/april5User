import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';

interface AnalyticsData {
  totalPickUps: number;
  onTimePickUps: number;
  missedPickUps: number;
  latePickUps: number;
  reliabilityScore: number;
}

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  standalone: false
})
export class AnalyticsPage implements OnInit {
  analytics: AnalyticsData = {
    totalPickUps: 120,
    onTimePickUps: 80,
    missedPickUps: 10,
    latePickUps: 30,
    reliabilityScore: 94
  };

  circumference: number = 2 * Math.PI * 26;
  strokeDashoffset: number = 0;

  constructor(private location: Location) { }

  ngOnInit() {
    this.calculateProgress();
  }

  calculateProgress() {
    const progress = this.analytics.reliabilityScore / 100;
    this.strokeDashoffset = this.circumference - (progress * this.circumference);
  }

  goBack() {
    this.location.back();
  }
}
