import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BottomNavigationComponent } from './bottom-navigation/bottom-navigation.component';
import { EmergencyBannerComponent } from './emergency-banner/emergency-banner.component';

@NgModule({
  declarations: [
    BottomNavigationComponent,
    EmergencyBannerComponent
  ],
  imports: [
    CommonModule,
    IonicModule
  ],
  exports: [
    BottomNavigationComponent,
    EmergencyBannerComponent
  ]
})
export class ComponentsModule { }
