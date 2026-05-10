import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { IonicModule, LoadingController, AlertController, ToastController } from '@ionic/angular';
import { LoginPage } from './login.page';
import { AuthService } from '../services/auth';

describe('LoginPage', () => {
  let component: LoginPage;
  let fixture: ComponentFixture<LoginPage>;
  let authService: jasmine.SpyObj<AuthService>;
  let loadingController: jasmine.SpyObj<LoadingController>;
  let alertController: jasmine.SpyObj<AlertController>;
  let toastController: jasmine.SpyObj<ToastController>;
  let router: jasmine.SpyObj<Router>;

  beforeEach(async () => {
    const authServiceSpy = jasmine.createSpyObj('AuthService', ['loginUser']);
    const loadingControllerSpy = jasmine.createSpyObj('LoadingController', ['create']);
    const alertControllerSpy = jasmine.createSpyObj('AlertController', ['create']);
    const toastControllerSpy = jasmine.createSpyObj('ToastController', ['create']);
    const routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    await TestBed.configureTestingModule({
      declarations: [LoginPage],
      imports: [IonicModule.forRoot()],
      providers: [
        { provide: AuthService, useValue: authServiceSpy },
        { provide: NotificationService, useValue: jasmine.createSpyObj('NotificationService', ['syncPendingPickupReminders30mForCurrentUser']) },
        { provide: LoadingController, useValue: loadingControllerSpy },
        { provide: AlertController, useValue: alertControllerSpy },
        { provide: ToastController, useValue: toastControllerSpy },
        { provide: Router, useValue: routerSpy }
      ]
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    loadingController = TestBed.inject(LoadingController) as jasmine.SpyObj<LoadingController>;
    alertController = TestBed.inject(AlertController) as jasmine.SpyObj<AlertController>;
    toastController = TestBed.inject(ToastController) as jasmine.SpyObj<ToastController>;
    router = TestBed.inject(Router) as jasmine.SpyObj<Router>;

    fixture = TestBed.createComponent(LoginPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with empty email and password', () => {
    expect(component.email).toBe('');
    expect(component.password).toBe('');
    expect(component.isLoading).toBe(false);
  });

  it('should not login with empty email', async () => {
    component.email = '';
    component.password = 'password123';

    const alertSpy = jasmine.createSpyObj('HTMLIonAlertElement', ['present']);
    alertController.create.and.returnValue(Promise.resolve(alertSpy));

    await component.login();

    expect(alertController.create).toHaveBeenCalled();
    expect(authService.loginUser).not.toHaveBeenCalled();
  });

  it('should not login with empty password', async () => {
    component.email = 'test@example.com';
    component.password = '';

    const alertSpy = jasmine.createSpyObj('HTMLIonAlertElement', ['present']);
    alertController.create.and.returnValue(Promise.resolve(alertSpy));

    await component.login();

    expect(alertController.create).toHaveBeenCalled();
    expect(authService.loginUser).not.toHaveBeenCalled();
  });

  it('should not login with invalid email format', async () => {
    component.email = 'invalid-email';
    component.password = 'password123';

    const alertSpy = jasmine.createSpyObj('HTMLIonAlertElement', ['present']);
    alertController.create.and.returnValue(Promise.resolve(alertSpy));

    await component.login();

    expect(alertController.create).toHaveBeenCalled();
    expect(authService.loginUser).not.toHaveBeenCalled();
  });

  it('should call authService.loginUser with valid credentials and navigate on success', async () => {
    component.email = 'grace.lim@gmail.com';
    component.password = 'password123';

    const mockLoading = jasmine.createSpyObj('HTMLIonLoadingElement', ['present', 'dismiss']);
    const mockToast = jasmine.createSpyObj('HTMLIonToastElement', ['present']);

    loadingController.create.and.returnValue(Promise.resolve(mockLoading));
    toastController.create.and.returnValue(Promise.resolve(mockToast));
    authService.loginUser.and.returnValue(Promise.resolve({
      success: true,
      message: 'Login successful',
      user: {
        uid: 'UMp5yZFYd0hlnHbiOJQZZv2',
        email: 'grace.lim@gmail.com',
        fullName: 'Grace Lim',
        contactNumber: '09212324307',
        password: 'password123',
        passwordConfirmation: 'password123'
      }
    }));

    await component.login();

    expect(authService.loginUser).toHaveBeenCalledWith('grace.lim@gmail.com', 'password123');
    expect(router.navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should show alert on login failure with invalid credentials', async () => {
    component.email = 'test@gmail.com';
    component.password = 'wrongpassword';

    const mockLoading = jasmine.createSpyObj('HTMLIonLoadingElement', ['present', 'dismiss']);
    const mockAlert = jasmine.createSpyObj('HTMLIonAlertElement', ['present']);

    loadingController.create.and.returnValue(Promise.resolve(mockLoading));
    alertController.create.and.returnValue(Promise.resolve(mockAlert));
    authService.loginUser.and.returnValue(Promise.resolve({
      success: false,
      message: 'Invalid email or password'
    }));

    await component.login();

    expect(alertController.create).toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('should navigate to register page', () => {
    component.goToRegister();
    expect(router.navigate).toHaveBeenCalledWith(['/register']);
  });

  it('should navigate to forgot password page', () => {
    component.goToForgotPassword();
    expect(router.navigate).toHaveBeenCalledWith(['/forgot-password']);
  });
});
