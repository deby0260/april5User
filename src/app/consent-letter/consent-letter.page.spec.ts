import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConsentLetterPage } from './consent-letter.page';

describe('ConsentLetterPage', () => {
  let component: ConsentLetterPage;
  let fixture: ComponentFixture<ConsentLetterPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ConsentLetterPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
