import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NotificationLogPage } from './notification-log.page';

describe('NotificationLogPage', () => {
  let component: NotificationLogPage;
  let fixture: ComponentFixture<NotificationLogPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(NotificationLogPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
