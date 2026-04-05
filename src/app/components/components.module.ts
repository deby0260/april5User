import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BottomNavigationComponent } from './bottom-navigation/bottom-navigation.component';

@NgModule({
  declarations: [
    BottomNavigationComponent
  ],
  imports: [
    CommonModule,
    IonicModule
  ],
  exports: [
    BottomNavigationComponent
  ]
})
export class ComponentsModule { }
