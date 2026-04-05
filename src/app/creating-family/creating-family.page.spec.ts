import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreatingFamilyPage } from './creating-family.page';

describe('CreatingFamilyPage', () => {
  let component: CreatingFamilyPage;
  let fixture: ComponentFixture<CreatingFamilyPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(CreatingFamilyPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
