import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SchedulingPage } from './scheduling.page';

describe('SchedulingPage', () => {
  let component: SchedulingPage;
  let fixture: ComponentFixture<SchedulingPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(SchedulingPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
