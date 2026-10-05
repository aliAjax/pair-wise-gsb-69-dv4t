import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ChangeStatus,
  RESOURCE_LABELS,
  RISK_LABELS,
  ResourceType,
  STATUS_LABELS,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestActions } from '../../store/change-request.actions';
import {
  selectAllChanges,
  selectChangesError,
  selectChangesLoading,
} from '../../store/change-request.selectors';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, ClarityModule, WindowGanttComponent],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">变更控制台</p>
        <h1>变更窗口与回滚审阅</h1>
        <p>集中检查资源依赖、窗口冲突、回滚可执行性和顺序会签状态。</p>
      </div>
      <a class="btn btn-primary" routerLink="/changes/new">
        <cds-icon shape="plus"></cds-icon>
        新建变更
      </a>
    </section>

    <section class="stats" aria-label="变更统计">
      <article>
        <span>待会签</span>
        <strong>{{ countByStatus('submitted') }}</strong>
        <small>需负责人顺序处理</small>
      </article>
      <article>
        <span>执行中</span>
        <strong>{{ countByStatus('executing') }}</strong>
        <small>需持续记录偏离</small>
      </article>
      <article class="danger">
        <span>有阻断项</span>
        <strong>{{ blockedCount() }}</strong>
        <small>依赖、冲突或回滚风险</small>
      </article>
      <article>
        <span>今日窗口</span>
        <strong>{{ todayWindowCount() }}</strong>
        <small>基于当前筛选数据</small>
      </article>
    </section>

    @if (error()) {
      <clr-alert clrAlertType="danger" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">{{ error() }}</span>
        </clr-alert-item>
      </clr-alert>
    }

    <section class="work-panel">
      <div class="panel-heading">
        <div>
          <h2>变更队列</h2>
          <span>{{ filteredChanges().length }} / {{ changes().length }} 条</span>
        </div>
        <button class="btn btn-sm" type="button" (click)="reload()" [disabled]="loading()">
          {{ loading() ? '加载中' : '刷新' }}
        </button>
      </div>

      <div class="filters">
        <clr-input-container>
          <label>关键词</label>
          <input
            clrInput
            type="search"
            placeholder="编号、标题、负责人"
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
          />
        </clr-input-container>
        <clr-select-container>
          <label>状态</label>
          <select clrSelect [ngModel]="status()" (ngModelChange)="status.set($event)">
            <option value="all">全部状态</option>
            @for (item of statuses; track item.value) {
              <option [value]="item.value">{{ item.label }}</option>
            }
          </select>
        </clr-select-container>
        <clr-select-container>
          <label>资源类型</label>
          <select
            clrSelect
            [ngModel]="resourceType()"
            (ngModelChange)="resourceType.set($event)"
          >
            <option value="all">全部资源</option>
            @for (item of resourceTypes; track item.value) {
              <option [value]="item.value">{{ item.label }}</option>
            }
          </select>
        </clr-select-container>
        <clr-select-container>
          <label>风险</label>
          <select clrSelect [ngModel]="risk()" (ngModelChange)="risk.set($event)">
            <option value="all">全部风险</option>
            <option value="critical">严重</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </clr-select-container>
      </div>

      <div class="change-table-wrap">
        <table class="change-table">
          <thead>
            <tr>
              <th>变更</th>
              <th>状态</th>
              <th>风险</th>
              <th>窗口</th>
              <th>负责人</th>
              <th>校验</th>
            </tr>
          </thead>
          <tbody>
            @for (change of filteredChanges(); track change.id) {
              <tr>
                <td>
                  <a [routerLink]="['/changes', change.id]" class="change-link">
                    <span>{{ change.id }}</span>
                    <strong>{{ change.title }}</strong>
                  </a>
                </td>
                <td>
                  <span class="status" [class]="change.status">{{ statusLabel(change.status) }}</span>
                </td>
                <td>
                  <span class="risk" [class]="change.risk">{{ riskLabel(change.risk) }}</span>
                </td>
                <td>
                  <div class="date-cell">
                    <span>{{ change.window.start | date: 'MM-dd HH:mm' }}</span>
                    <small>至 {{ change.window.end | date: 'MM-dd HH:mm' }}</small>
                  </div>
                </td>
                <td>{{ change.owner }}</td>
                <td>
                  @if (issueCount(change.id); as count) {
                    <span class="issue-count">{{ count }} 项</span>
                  } @else {
                    <span class="issue-count clear">通过</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="empty-row">没有符合条件的变更。</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="work-panel">
      <div class="panel-heading">
        <div>
          <h2>窗口甘特视图</h2>
          <span>红色条表示共享资源窗口冲突</span>
        </div>
      </div>
      <app-window-gantt [changes]="filteredChanges()" />
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .page-heading {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 24px;
        margin-bottom: 22px;
      }

      h1 {
        margin: 4px 0 8px;
        font-size: 28px;
        color: #1b1b1b;
      }

      .eyebrow {
        margin: 0;
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .page-heading p:last-child {
        margin: 0;
        color: #5e5e5e;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1px;
        margin-bottom: 22px;
        border: 1px solid #d7d7d7;
        background: #d7d7d7;
      }

      .stats article {
        display: flex;
        flex-direction: column;
        min-height: 110px;
        padding: 18px;
        background: #ffffff;
        border-top: 3px solid #266c91;
      }

      .stats article.danger {
        border-top-color: #c21d00;
      }

      .stats span,
      .stats small {
        color: #666;
      }

      .stats strong {
        margin: 5px 0;
        color: #1b1b1b;
        font-size: 30px;
      }

      .work-panel {
        margin-bottom: 24px;
        border: 1px solid #d7d7d7;
        background: #ffffff;
      }

      .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 18px;
        border-bottom: 1px solid #d7d7d7;
      }

      .panel-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .panel-heading span {
        color: #6b6b6b;
        font-size: 12px;
      }

      .filters {
        display: grid;
        grid-template-columns: 1.6fr repeat(3, minmax(150px, 0.7fr));
        gap: 16px;
        padding: 18px 18px 4px;
        border-bottom: 1px solid #d7d7d7;
      }

      .change-link {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .change-table-wrap {
        overflow-x: auto;
      }

      .change-table {
        width: 100%;
        min-width: 900px;
        border-collapse: collapse;
        text-align: left;
      }

      .change-table th {
        padding: 10px 14px;
        border-bottom: 1px solid #d7d7d7;
        background: #f7f8f8;
        color: #666;
        font-size: 11px;
        font-weight: 600;
      }

      .change-table td {
        padding: 13px 14px;
        border-bottom: 1px solid #e4e4e4;
        vertical-align: middle;
      }

      .change-table tbody tr:hover {
        background: #f8fbfc;
      }

      .empty-row {
        padding: 36px 14px !important;
        text-align: center;
        color: #737373;
      }

      .change-link span {
        color: #266c91;
        font-size: 11px;
      }

      .change-link strong {
        color: #1b1b1b;
      }

      .status,
      .risk,
      .issue-count {
        display: inline-block;
        padding: 2px 7px;
        border: 1px solid #a4a4a4;
        color: #414141;
        background: #f2f2f2;
        font-size: 11px;
      }

      .status.executing,
      .status.approved {
        border-color: #4b8d65;
        color: #245f3d;
        background: #e8f5ed;
      }

      .status.submitted {
        border-color: #5688a5;
        color: #215a78;
        background: #eaf4f9;
      }

      .status.rejected,
      .status.rolled_back,
      .risk.critical,
      .risk.high,
      .issue-count {
        border-color: #d58d7e;
        color: #8e260f;
        background: #fbece8;
      }

      .risk.medium {
        border-color: #d0a251;
        color: #7c5000;
        background: #fff7e6;
      }

      .risk.low,
      .issue-count.clear {
        border-color: #8fb99f;
        color: #286140;
        background: #edf7f0;
      }

      .date-cell {
        display: flex;
        flex-direction: column;
      }

      .date-cell small {
        color: #737373;
      }

      @media (max-width: 980px) {
        .stats {
          grid-template-columns: repeat(2, 1fr);
        }

        .filters {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 640px) {
        .page-heading {
          align-items: flex-start;
          flex-direction: column;
        }

        .stats,
        .filters {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class DashboardComponent {
  private readonly store = inject(Store);

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly loading = this.store.selectSignal(selectChangesLoading);
  readonly error = this.store.selectSignal(selectChangesError);

  readonly query = signal('');
  readonly status = signal<ChangeStatus | 'all'>('all');
  readonly resourceType = signal<ResourceType | 'all'>('all');
  readonly risk = signal('all');

  readonly statuses = Object.entries(STATUS_LABELS).map(([value, label]) => ({
    value: value as ChangeStatus,
    label,
  }));
  readonly resourceTypes = Object.entries(RESOURCE_LABELS).map(([value, label]) => ({
    value: value as ResourceType,
    label,
  }));

  readonly filteredChanges = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const resourceType = this.resourceType();
    const risk = this.risk();

    return this.changes().filter((change) => {
      const searchable = `${change.id} ${change.title} ${change.owner}`.toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesStatus = status === 'all' || change.status === status;
      const matchesResource =
        resourceType === 'all' ||
        change.resources.some((resource) => resource.type === resourceType);
      const matchesRisk = risk === 'all' || change.risk === risk;
      return matchesQuery && matchesStatus && matchesResource && matchesRisk;
    });
  });

  readonly blockedCount = computed(
    () =>
      this.changes().filter((change) =>
        validateChange(change, this.changes()).some((issue) => issue.severity === 'blocker'),
      ).length,
  );

  readonly todayWindowCount = computed(() =>
    this.filteredChanges().filter((change) => change.window.start.startsWith('2026-09-29')).length,
  );

  reload(): void {
    this.store.dispatch(ChangeRequestActions.loadChanges());
  }

  countByStatus(status: ChangeStatus): number {
    return this.changes().filter((change) => change.status === status).length;
  }

  issueCount(changeId: string): number {
    const change = this.changes().find((item) => item.id === changeId);
    return change ? validateChange(change, this.changes()).length : 0;
  }

  statusLabel(status: ChangeStatus): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: 'low' | 'medium' | 'high' | 'critical'): string {
    return RISK_LABELS[risk];
  }
}
