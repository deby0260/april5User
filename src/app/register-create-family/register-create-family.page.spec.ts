import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RegisterCreateFamilyPage } from './register-create-family.page';

describe('RegisterCreateFamilyPage', () => {
  let component: RegisterCreateFamilyPage;
  let fixture: ComponentFixture<RegisterCreateFamilyPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(RegisterCreateFamilyPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
