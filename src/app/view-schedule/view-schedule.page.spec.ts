import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ViewSchedulePage } from './view-schedule.page';

describe('ViewSchedulePage', () => {
  let component: ViewSchedulePage;
  let fixture: ComponentFixture<ViewSchedulePage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ViewSchedulePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
