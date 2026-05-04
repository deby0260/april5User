import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { RouteReuseStrategy } from '@angular/router';

import { IonicModule, IonicRouteStrategy } from '@ionic/angular';

// Firebase imports
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { provideAnalytics, getAnalytics } from '@angular/fire/analytics';
import { provideStorage, getStorage } from '@angular/fire/storage';
import { provideFunctions, getFunctions } from '@angular/fire/functions';
import { environment } from '../environments/environment';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { ComponentsModule } from './components/components.module';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    IonicModule.forRoot(),
    AppRoutingModule,
    ComponentsModule
  ],
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideFirestore(() => getFirestore()),
    provideAuth(() => getAuth()),
    provideAnalytics(() => getAnalytics()),
    provideStorage(() => getStorage()),
    provideFunctions(() => getFunctions(undefined, environment.firebaseFunctionsRegion))
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
