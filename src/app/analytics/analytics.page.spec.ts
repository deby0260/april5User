import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AnalyticsPage } from './analytics.page';
import { Location } from '@angular/common';
import { AnalyticsPunctualityService } from '../services/analytics-punctuality.service';
import { AnalyticsSafetyService } from '../services/analytics-safety.service';
import { FamilyService } from '../services/family.service';
import { RoleAccessService } from '../services/role-access.service';

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
        {
          provide: AnalyticsSafetyService,
          useValue: {
            loadSafetyAnalytics: async () => ({
              pickupHistory: [],
              panicAlertMs: [],
              panicSelectorBounds: {
                minYear: 2025,
                maxYear: 2026,
                maxMonthInMaxYear: 5,
              },
              currentMonthValue: '2026-05',
            }),
            buildPanicMonthBuckets: () => ({ dailyBuckets: [], total: 0 }),
          },
        },
        {
          provide: RoleAccessService,
          useValue: {
            getUserRole: async () => ({ canAccessAnalytics: true, role: 'parent' }),
            getAccessDeniedMessage: () => 'Access denied',
          },
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
