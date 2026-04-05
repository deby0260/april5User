import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';
import { ComponentsModule } from '../components/components.module';

import { ViewConsentLetterPageRoutingModule } from './view-consent-letter-routing.module';

import { ViewConsentLetterPage } from './view-consent-letter.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    ViewConsentLetterPageRoutingModule,
    ComponentsModule
  ],
  declarations: [ViewConsentLetterPage]
})
export class ViewConsentLetterPageModule {}
