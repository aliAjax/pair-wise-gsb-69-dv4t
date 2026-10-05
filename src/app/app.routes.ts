import { Routes } from '@angular/router';
import { ChangeDetailComponent } from './pages/change-detail/change-detail.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { NewChangeComponent } from './pages/new-change/new-change.component';

export const routes: Routes = [
  {
    path: '',
    component: DashboardComponent,
    title: '变更工作台',
  },
  {
    path: 'changes/new',
    component: NewChangeComponent,
    title: '新建变更',
  },
  {
    path: 'changes/:id',
    component: ChangeDetailComponent,
    title: '变更详情',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
