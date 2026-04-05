import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { RegisterCreateFamilyPageRoutingModule } from './register-create-family-routing.module';
import { ComponentsModule } from '../components/components.module';

import { RegisterCreateFamilyPage } from './register-create-family.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    RegisterCreateFamilyPageRoutingModule,
    ComponentsModule
  ],
  declarations: [RegisterCreateFamilyPage]
})
export class RegisterCreateFamilyPageModule {}
