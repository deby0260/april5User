import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AnalyticsPage } from './analytics.page';
import { Location } from '@angular/common';
import { AnalyticsPunctualityService } from '../services/analytics-punctuality.service';
import { FamilyService } from '../services/family.service';

describe('AnalyticsPage', () => {
  let component: AnalyticsPage;
  let fixture: ComponentFixture<AnalyticsPage>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [AnalyticsPage],
      providers: [
        { provide: Location, useValue: { back: () => {} } },
        {
          provide: AnalyticsPunctualityService,
          useValue: {
            loadFamilyAnalytics: async () => ({
              totals: {
                totalPickUps: 0,
                onTimePickUps: 0,
                missedPickUps: 0,
                latePickUps: 0,
                reliabilityScore: 0,
              },
              weekBars: [],
              trend: [],
              fetcherOptions: [],
            }),
          },
        },
        {
          provide: FamilyService,
          useValue: { getUserFamily: async () => null },
        },
      ],
    });
    fixture = TestBed.createComponent(AnalyticsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
