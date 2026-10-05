import { DatePipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { ChangeRequest } from '../../models/change-request.model';
import {
  DRILL_STATUS_LABELS,
  DrillBatch,
  DrillStatus,
  GATE_STATE_LABELS,
} from '../../models/rollback-drill.model';
import { RollbackDrillService } from '../../services/rollback-drill.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectAllChanges } from '../../store/change-request.selectors';
import { RollbackDrillActions } from '../../store/rollback-drill.actions';
import {
  selectDrillNotice,
  selectDrillQueueViewsByChangeId,
  selectExecutionGateByChangeId,
  selectUnpersistedBatches,
  selectVersionByChangeId,
} from '../../store/rollback-drill.selectors';

@Component({
  selector: 'app-rollback-drill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgClass, FormsModule, RouterLink, ClarityModule],
  template: `
    <div class="content-grid drill-grid">
      <section class="surface span-2 gate-strip" [ngClass]="{ blocked: !gate().allowed }">
        <div class="gate-main">
          <span class="gate-eyebrow">执行门禁 · 回滚演练凭证</span>
          @if (version(); as version) {
            <div class="gate-version">
              <strong>{{ version.versionLabel }}</strong>
              <span class="chip" [ngClass]="version.gateState">
                {{ gateStateLabel(version.gateState) }}
              </span>
            </div>
            <dl class="digests">
              <div>
                <dt>拓扑</dt>
                <dd>{{ version.topologyDigest.slice(0, 10) }}</dd>
              </div>
              <div>
                <dt>回滚命令</dt>
                <dd>{{ version.commandDigest.slice(0, 10) }}</dd>
              </div>
              <div>
                <dt>窗口</dt>
                <dd>{{ version.windowDigest.slice(0, 10) }}</dd>
              </div>
              <div>
                <dt>会签摘要</dt>
                <dd>{{ version.approvalDigest.slice(0, 10) }}</dd>
              </div>
            </dl>
          } @else {
            <strong>方案版本尚未登记</strong>
          }
          <p class="gate-reason" [class.ok]="gate().allowed">{{ gate().reason }}</p>
        </div>
        <div class="gate-actions">
          @if (change().status === 'approved') {
            <button class="btn btn-primary" type="button" (click)="requestExecution()">
              凭证放行执行
            </button>
          }
        </div>
      </section>

      <section class="surface">
        <div class="surface-heading">
          <div>
            <h2>提交回滚演练</h2>
            <span>演练按共享资源（隔离链路）排队，与正式变更同池</span>
          </div>
        </div>
        <div class="drill-form">
          <clr-input-container>
            <label>值班员</label>
            <input
              clrInput
              [ngModel]="operator()"
              (ngModelChange)="operator.set($event)"
              [placeholder]="change().onCall[0] || '值班员'"
            />
          </clr-input-container>
          <div class="drill-form-actions">
            <button class="btn btn-primary" type="button" (click)="submitDrill()">
              提交演练批次
            </button>
            <button class="btn" type="button" (click)="simulateConcurrent()">
              模拟另一值班员同时提交
            </button>
          </div>
          <p class="hint">
            两个值班员同时提交时先到生效、后到保留冲突；同一提交令牌重复重放不新增凭证。
          </p>
        </div>

        @if (notice(); as notice) {
          <clr-alert
            [clrAlertType]="
              notice.kind === 'conflict' || notice.kind.startsWith('persist') ? 'warning' : 'info'
            "
            [clrAlertClosable]="true"
            (clrAlertClosedChange)="dismissNotice()"
          >
            <clr-alert-item
              ><span class="alert-text">{{ notice.message }}</span></clr-alert-item
            >
          </clr-alert>
        }
      </section>

      <section class="surface">
        <div class="surface-heading">
          <div>
            <h2>当前凭证</h2>
            <span>仅与当前版本一致的凭证可放行；旧版本凭证保留但不放行</span>
          </div>
        </div>
        @if (gate().credential; as credential) {
          <article class="credential-card">
            <header>
              <strong>{{ credential.id }}</strong>
              <span class="chip active">已签发 · 与当前版本一致</span>
            </header>
            <p>
              由 {{ credential.issuedBy }} 于 {{ credential.issuedAt | date: 'MM-dd HH:mm' }} 签发，
              来源批次 {{ credential.batchId }}
            </p>
            <div class="frozen">
              <h3>冻结拓扑摘要</h3>
              <ul>
                @for (line of credential.frozen.topologySummary; track line) {
                  <li>{{ line }}</li>
                }
              </ul>
              <h3>冻结回滚命令摘要</h3>
              <ul>
                @for (command of credential.frozen.commandSummary; track command.stepId) {
                  <li>
                    <code>{{ command.command }}</code>
                    <span>{{ command.title }} · {{ command.owner || '未指定责任人' }}</span>
                  </li>
                }
              </ul>
              <p class="window-label">冻结窗口：{{ credential.frozen.windowLabel }}</p>
            </div>
          </article>
        } @else {
          <p class="empty">
            @if (version()?.gateState === 'legacy_backfill') {
              旧方案没有回滚演练凭证，已列入待补，补齐前不能开始执行。
            } @else {
              尚未取得当前版本的回滚演练凭证。
            }
          </p>
        }
      </section>

      <section class="surface span-2">
        <div class="surface-heading">
          <div>
            <h2>演练批次队列</h2>
            <span>共享资源先到先用；占用释放后后到批次自动解除阻塞</span>
          </div>
        </div>
        <table class="drill-table">
          <thead>
            <tr>
              <th>批次</th>
              <th>版本</th>
              <th>值班员</th>
              <th>状态</th>
              <th>排队/资源依赖</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            @for (view of queueViews(); track view.drill.id) {
              <tr [ngClass]="view.drill.status">
                <td>
                  <strong>{{ view.drill.batch.id }}</strong>
                  <small
                    >#{{ view.drill.batch.order }} · 重放{{
                      view.drill.batch.replayed ? '（恢复）' : ''
                    }}</small
                  >
                </td>
                <td>{{ view.drill.versionLabel }}</td>
                <td>{{ view.drill.submittedBy }}</td>
                <td>
                  <span class="status-chip" [ngClass]="view.drill.status">{{
                    statusLabel(view.drill.status)
                  }}</span>
                </td>
                <td>
                  @if (view.liveBlockers.length) {
                    <ul class="blockers">
                      @for (blocker of view.liveBlockers; track blocker.kind + blocker.holderId) {
                        <li>
                          等待{{ blocker.kind === 'formal_change' ? '正式变更' : '先到演练' }}
                          <a [routerLink]="['/changes', blocker.changeId]">{{
                            blocker.holderLabel
                          }}</a>
                          释放 {{ blocker.resourceIds.join('、') }}
                        </li>
                      }
                    </ul>
                  } @else if (view.drill.status === 'queued') {
                    <span class="ready">共享资源已到位</span>
                  } @else {
                    <span class="muted">—</span>
                  }
                  @if (view.drill.invalidReason) {
                    <p class="invalid-reason">{{ view.drill.invalidReason }}</p>
                  }
                </td>
                <td class="row-actions">
                  @if (view.drill.status === 'queued' && view.ready) {
                    <button class="btn btn-sm" type="button" (click)="startBatch(view.drill.id)">
                      开始演练
                    </button>
                  }
                  @if (view.drill.status === 'running') {
                    <button
                      class="btn btn-sm btn-success"
                      type="button"
                      (click)="complete(view.drill.id, true)"
                    >
                      演练成功（冻结发证）
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      type="button"
                      (click)="complete(view.drill.id, false)"
                    >
                      演练失败
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="empty">该变更暂无演练批次。</td>
              </tr>
            }
          </tbody>
        </table>
      </section>

      <section class="surface span-2">
        <div class="surface-heading">
          <div>
            <h2>写入失败与完整批次恢复</h2>
            <span>写入失败后从完整演练批次恢复，重复重放不新增凭证</span>
          </div>
          <div class="recovery-actions">
            <button class="btn btn-sm btn-warning-outline" type="button" (click)="toggleFault()">
              {{ faultInjected() ? '取消注入' : '注入下一次写入失败' }}
            </button>
            <button class="btn btn-sm btn-danger-outline" type="button" (click)="resetDrillData()">
              清空本地演练数据（模拟丢盘）
            </button>
          </div>
        </div>

        @if (unpersisted().length) {
          <p class="hint warn">
            下列批次尚未确认持久化。复制完整批次 JSON，清空数据后可用它恢复：身份确定性生成，
            重放不新增凭证。
          </p>
          <div class="batch-recovery">
            @for (batch of unpersisted(); track batch.id) {
              <article>
                <header>
                  <strong>{{ batch.id }}</strong>
                  <button class="btn btn-sm" type="button" (click)="recover(batch)">
                    从此批次恢复
                  </button>
                </header>
                <textarea readonly rows="4" [value]="toJson(batch)"></textarea>
              </article>
            }
          </div>
        } @else {
          <p class="empty">当前没有待恢复批次；也可粘贴此前导出的完整批次 JSON 恢复：</p>
        }

        <div class="recover-paste">
          <clr-textarea-container>
            <label>粘贴完整批次 JSON</label>
            <textarea
              clrTextarea
              rows="3"
              [ngModel]="recoveryJson()"
              (ngModelChange)="recoveryJson.set($event)"
              placeholder='{"id":"BAT-...","clientToken":"...","planSnapshot":{...}}'
            ></textarea>
          </clr-textarea-container>
          <button class="btn" type="button" (click)="recoverFromJson()">重放恢复批次</button>
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .drill-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .gate-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        border-left: 4px solid #4b8d65;
      }

      .gate-strip.blocked {
        border-left-color: #c21d00;
        background: #fdf5f3;
      }

      .gate-eyebrow {
        color: #266c91;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .gate-version {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 8px 0;
      }

      .gate-version strong {
        font-size: 18px;
      }

      .digests {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin: 0 0 10px;
      }

      .digests dt {
        color: #777;
        font-size: 11px;
      }

      .digests dd {
        margin: 2px 0 0;
        font-family: monospace;
        font-size: 12px;
      }

      .gate-reason {
        margin: 0;
        color: #8e260f;
        font-size: 13px;
      }

      .gate-reason.ok {
        color: #245f3d;
      }

      .chip,
      .status-chip {
        display: inline-block;
        padding: 2px 8px;
        border: 1px solid #a4a4a4;
        background: #f2f2f2;
        color: #414141;
        font-size: 11px;
      }

      .chip.active {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .chip.legacy_backfill,
      .status-chip.queued,
      .status-chip.conflict_retained,
      .status-chip.invalidated {
        border-color: #d0a251;
        background: #fff7e6;
        color: #7c5000;
      }

      .status-chip.running {
        border-color: #5688a5;
        background: #eaf4f9;
        color: #215a78;
      }

      .status-chip.succeeded {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .status-chip.failed {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .drill-form-actions {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }

      .hint {
        color: #6b6b6b;
        font-size: 12px;
      }

      .hint.warn {
        color: #8e260f;
      }

      .credential-card header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .credential-card p {
        color: #5f5f5f;
        font-size: 12px;
      }

      .frozen {
        margin-top: 12px;
        padding: 14px;
        background: #f4f7f9;
        border-left: 3px solid #266c91;
      }

      .frozen h3 {
        margin: 8px 0 6px;
        font-size: 13px;
      }

      .frozen ul {
        margin: 0;
        padding-left: 18px;
      }

      .frozen li {
        display: flex;
        flex-direction: column;
        margin-bottom: 4px;
        font-size: 12px;
      }

      .frozen code {
        color: #174d6a;
      }

      .frozen span,
      .window-label {
        color: #666;
        font-size: 11px;
      }

      .drill-table {
        width: 100%;
        border-collapse: collapse;
      }

      .drill-table th {
        padding: 10px 12px;
        background: #f7f8f8;
        color: #666;
        font-size: 11px;
        text-align: left;
      }

      .drill-table td {
        padding: 12px;
        border-bottom: 1px solid #e4e4e4;
        vertical-align: top;
        font-size: 13px;
      }

      .drill-table small {
        display: block;
        color: #888;
        font-size: 11px;
      }

      .blockers {
        margin: 0;
        padding-left: 16px;
      }

      .blockers li {
        margin-bottom: 4px;
        color: #7c5000;
        font-size: 12px;
      }

      .ready {
        color: #245f3d;
        font-size: 12px;
      }

      .muted {
        color: #999;
      }

      .invalid-reason {
        margin: 6px 0 0;
        color: #8e260f;
        font-size: 11px;
      }

      .row-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .recovery-actions {
        display: flex;
        gap: 8px;
      }

      .batch-recovery {
        display: grid;
        gap: 10px;
        margin-bottom: 14px;
      }

      .batch-recovery article header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .batch-recovery textarea {
        width: 100%;
        font-family: monospace;
        font-size: 11px;
      }

      .recover-paste {
        display: grid;
        gap: 8px;
      }

      .empty {
        color: #737373;
      }

      @media (max-width: 900px) {
        .drill-grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class RollbackDrillComponent {
  private readonly store = inject(Store);
  private readonly drillService = inject(RollbackDrillService);
  readonly changeId = input('');

  private readonly allChanges = this.store.selectSignal(selectAllChanges);
  readonly change = computed(
    () => this.allChanges().find((item) => item.id === this.changeId()) as ChangeRequest,
  );
  readonly version = this.store.selectSignal(selectVersionByChangeId(this.changeId()));
  readonly gate = this.store.selectSignal(selectExecutionGateByChangeId(this.changeId()));
  readonly queueViews = this.store.selectSignal(selectDrillQueueViewsByChangeId(this.changeId()));
  readonly notice = this.store.selectSignal(selectDrillNotice);
  readonly unpersisted = this.store.selectSignal(selectUnpersistedBatches);

  readonly operator = signal('');
  readonly faultInjected = signal(false);
  readonly recoveryJson = signal('');

  private tokenSeed = 0;

  currentOperator(): string {
    return this.operator().trim() || this.change()?.onCall[0] || '值班员';
  }

  submitDrill(asOperator?: string): void {
    this.tokenSeed += 1;
    this.store.dispatch(
      RollbackDrillActions.submitDrill({
        input: {
          change: this.change(),
          submittedBy: asOperator ?? this.currentOperator(),
          clientToken: `tok-${Date.now()}-${this.tokenSeed}`,
        },
      }),
    );
  }

  simulateConcurrent(): void {
    // 同一时刻两个值班员提交：令牌不同，先到生效，后到保留冲突
    const base = Date.now();
    this.tokenSeed += 1;
    const firstToken = `tok-${base}-a${this.tokenSeed}`;
    this.tokenSeed += 1;
    const secondToken = `tok-${base}-b${this.tokenSeed}`;
    this.store.dispatch(
      RollbackDrillActions.submitDrill({
        input: { change: this.change(), submittedBy: '值班员甲', clientToken: firstToken },
      }),
    );
    this.store.dispatch(
      RollbackDrillActions.submitDrill({
        input: { change: this.change(), submittedBy: '值班员乙', clientToken: secondToken },
      }),
    );
  }

  startBatch(drillId: string): void {
    this.store.dispatch(RollbackDrillActions.startBatch({ drillId }));
  }

  complete(drillId: string, success: boolean): void {
    this.store.dispatch(
      RollbackDrillActions.completeBatch({
        drillId,
        result: success ? 'success' : 'failure',
        note: success
          ? '回滚步骤在隔离链路上全部验证通过，拓扑与命令摘要已冻结。'
          : '回滚演练未达到预期，需修正方案后重新演练。',
      }),
    );
  }

  requestExecution(): void {
    this.store.dispatch(ChangeRequestActions.startExecution({ id: this.changeId() }));
  }

  toggleFault(): void {
    const next = !this.faultInjected();
    this.faultInjected.set(next);
    this.drillService.failNextWrites = next;
  }

  resetDrillData(): void {
    this.drillService.clear();
    this.store.dispatch(RollbackDrillActions.resetDrillData());
  }

  recover(batch: DrillBatch): void {
    this.store.dispatch(RollbackDrillActions.recoverFromBatch({ batch: structuredClone(batch) }));
  }

  recoverFromJson(): void {
    try {
      const batch = JSON.parse(this.recoveryJson()) as DrillBatch;
      if (!batch.clientToken || !batch.planSnapshot) {
        throw new Error('缺少 clientToken 或 planSnapshot');
      }
      this.recover(batch);
      this.recoveryJson.set('');
    } catch (error) {
      this.store.dispatch(
        RollbackDrillActions.recoverFromBatchFailure({
          batchId: '粘贴批次',
          error: error instanceof Error ? error.message : 'JSON 无法解析',
        }),
      );
    }
  }

  dismissNotice(): void {
    this.store.dispatch(RollbackDrillActions.clearNotice());
  }

  toJson(batch: DrillBatch): string {
    return JSON.stringify(batch, null, 0);
  }

  statusLabel(status: DrillStatus): string {
    return DRILL_STATUS_LABELS[status];
  }

  gateStateLabel(state: 'active' | 'legacy_backfill'): string {
    return GATE_STATE_LABELS[state];
  }
}
