import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PasswordChangeModalComponent } from './password-change-modal.component';
import { IonicModule } from '@ionic/angular';

describe('PasswordChangeModalComponent', () => {
  let component: PasswordChangeModalComponent;
  let fixture: ComponentFixture<PasswordChangeModalComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [PasswordChangeModalComponent],
      imports: [IonicModule.forRoot()]
    }).compileComponents();

    fixture = TestBed.createComponent(PasswordChangeModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should toggle password visibility', () => {
    expect(component.showPassword).toBeFalsy();
    component.togglePasswordVisibility();
    expect(component.showPassword).toBeTruthy();
    component.togglePasswordVisibility();
    expect(component.showPassword).toBeFalsy();
  });

  it('should toggle confirm password visibility', () => {
    expect(component.showConfirmPassword).toBeFalsy();
    component.toggleConfirmPasswordVisibility();
    expect(component.showConfirmPassword).toBeTruthy();
    component.toggleConfirmPasswordVisibility();
    expect(component.showConfirmPassword).toBeFalsy();
  });

  it('should validate passwords correctly', () => {
    component.newPassword = '';
    component.confirmPassword = '';
    let validation = component.validatePasswords();
    expect(validation.valid).toBeFalsy();

    component.newPassword = '123456';
    component.confirmPassword = '123456';
    validation = component.validatePasswords();
    expect(validation.valid).toBeTruthy();
  });
});
