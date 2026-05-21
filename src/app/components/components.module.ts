import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BottomNavigationComponent } from './bottom-navigation/bottom-navigation.component';
import { EmergencyBannerComponent } from './emergency-banner/emergency-banner.component';
import { ShellHeaderComponent } from './shell-header/shell-header.component';
import { OfflineBannerComponent } from './offline-banner/offline-banner.component';

@NgModule({
  declarations: [
    BottomNavigationComponent,
    EmergencyBannerComponent,
    ShellHeaderComponent,
    OfflineBannerComponent,
  ],
  imports: [
    CommonModule,
    IonicModule
  ],
  exports: [
    BottomNavigationComponent,
    EmergencyBannerComponent,
    ShellHeaderComponent,
    OfflineBannerComponent,
  ]
})
export class ComponentsModule { }
