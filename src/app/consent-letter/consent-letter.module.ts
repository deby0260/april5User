import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';
import { ComponentsModule } from '../components/components.module';

import { ConsentLetterPageRoutingModule } from './consent-letter-routing.module';

import { ConsentLetterPage } from './consent-letter.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    ConsentLetterPageRoutingModule,
    ComponentsModule
  ],
  declarations: [ConsentLetterPage]
})
export class ConsentLetterPageModule {}
