import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreatedFamilyPage } from './created-family.page';

describe('CreatedFamilyPage', () => {
  let component: CreatedFamilyPage;
  let fixture: ComponentFixture<CreatedFamilyPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(CreatedFamilyPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
