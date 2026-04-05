import { NgModule } from '@angular/core';
import { PreloadAllModules, RouterModule, Routes } from '@angular/router';
import { authGuard } from './guards/auth-guard';
import { FamilyGuard } from './guards/family.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/home-screen',
    pathMatch: 'full'
  },
  {
    path: 'home-screen',
    loadChildren: () => import('./home-screen/home-screen.module').then( m => m.HomeScreenPageModule)
  },
  
  {
    path: 'login',
    loadChildren: () => import('./login/login.module').then( m => m.LoginPageModule)
  },
  {
    path: 'register',
    loadChildren: () => import('./register/register.module').then( m => m.RegisterPageModule)
  },
  {
    path: 'home',
    loadChildren: () => import('./home/home.module').then( m => m.HomePageModule),
    canActivate: [authGuard]
  },
  {
    path: 'register-create-family',
    loadChildren: () => import('./register-create-family/register-create-family.module').then( m => m.RegisterCreateFamilyPageModule),
    canActivate: [authGuard, FamilyGuard]
  },
  {
    path: 'creating-family',
    loadChildren: () => import('./creating-family/creating-family.module').then( m => m.CreatingFamilyPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'created-family',
    loadChildren: () => import('./created-family/created-family.module').then( m => m.CreatedFamilyPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'notification-log',
    loadChildren: () => import('./notification-log/notification-log.module').then( m => m.NotificationLogPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'settings',
    loadChildren: () => import('./settings/settings.module').then( m => m.SettingsPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'consent-letter',
    loadChildren: () => import('./consent-letter/consent-letter.module').then( m => m.ConsentLetterPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'analytics',
    loadChildren: () => import('./analytics/analytics.module').then( m => m.AnalyticsPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'forgot-password',
    loadChildren: () => import('./forgot-password/forgot-password.module').then( m => m.ForgotPasswordPageModule)
  },
  {
    path: 'scheduling',
    loadChildren: () => import('./scheduling/scheduling.module').then( m => m.SchedulingPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'qr-code',
    loadChildren: () => import('./qr-code/qr-code.module').then( m => m.QrCodePageModule),
    canActivate: [authGuard]
  },
  {
    path: 'view-schedule',
    loadChildren: () => import('./view-schedule/view-schedule.module').then( m => m.ViewSchedulePageModule),
    canActivate: [authGuard]
  },
  {
    path: 'view-consent-letter',
    loadChildren: () => import('./view-consent-letter/view-consent-letter.module').then( m => m.ViewConsentLetterPageModule),
    canActivate: [authGuard]
  },
  {
    path: 'notifications',
    loadChildren: () => import('./notifications/notifications.module').then( m => m.NotificationsPageModule),
    canActivate: [authGuard]
  }
];
@NgModule({
  imports: [
    RouterModule.forRoot(routes, { preloadingStrategy: PreloadAllModules })
  ],
  exports: [RouterModule]
})
export class AppRoutingModule {}
