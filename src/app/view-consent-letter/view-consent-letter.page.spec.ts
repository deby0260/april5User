import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ViewConsentLetterPage } from './view-consent-letter.page';

describe('ViewConsentLetterPage', () => {
  let component: ViewConsentLetterPage;
  let fixture: ComponentFixture<ViewConsentLetterPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ViewConsentLetterPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
