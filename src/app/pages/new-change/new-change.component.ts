import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { ValidationPanelComponent } from '../../components/validation-panel/validation-panel.component';
import {
  APPROVAL_ORDER,
  ChangeRequest,
  ChangeStep,
  RESOURCE_LABELS,
  ResourceType,
  StepPhase,
  createEmptyChange,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectAllChanges } from '../../store/change-request.selectors';

@Component({
  selector: 'app-new-change',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ClarityModule, ValidationPanelComponent],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">方案编辑</p>
        <h1>新建变更窗口</h1>
        <p>先定义影响范围、执行步骤和回滚条件，再提交顺序会签。</p>
      </div>
    </section>

    <div class="editor-layout">
      <section class="form-surface">
        <div class="section-heading">
          <span>01</span>
          <div>
            <h2>基本信息</h2>
            <p>用于审批队列识别和值班通知。</p>
          </div>
        </div>
        <div class="form-grid">
          <clr-input-container>
            <label class="required">变更标题</label>
            <input
              clrInput
              [ngModel]="draft().title"
              (ngModelChange)="update('title', $event)"
              placeholder="例如：交易区接入交换机升级"
            />
          </clr-input-container>
          <clr-input-container>
            <label class="required">变更负责人</label>
            <input
              clrInput
              [ngModel]="draft().owner"
              (ngModelChange)="update('owner', $event)"
              placeholder="姓名"
            />
          </clr-input-container>
          <clr-select-container>
            <label>风险等级</label>
            <select clrSelect [ngModel]="draft().risk" (ngModelChange)="update('risk', $event)">
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="critical">严重</option>
            </select>
          </clr-select-container>
          <clr-input-container>
            <label class="required">值守人员</label>
            <input
              clrInput
              [ngModel]="onCallText()"
              (ngModelChange)="setOnCall($event)"
              placeholder="逗号分隔"
            />
          </clr-input-container>
          <clr-textarea-container class="span-2">
            <label>变更摘要</label>
            <textarea
              clrTextarea
              rows="3"
              [ngModel]="draft().summary"
              (ngModelChange)="update('summary', $event)"
              placeholder="说明目标、影响和不在范围内的内容"
            ></textarea>
          </clr-textarea-container>
        </div>
      </section>

      <section class="form-surface">
        <div class="section-heading">
          <span>02</span>
          <div>
            <h2>资源与依赖</h2>
            <p>依赖对象应与资源 ID 匹配，以参与冲突和遗漏检查。</p>
          </div>
        </div>
        <div class="inline-form">
          <clr-input-container>
            <label>资源 ID</label>
            <input clrInput [ngModel]="resourceId()" (ngModelChange)="resourceId.set($event)" />
          </clr-input-container>
          <clr-input-container>
            <label>资源名称</label>
            <input
              clrInput
              [ngModel]="resourceName()"
              (ngModelChange)="resourceName.set($event)"
            />
          </clr-input-container>
          <clr-select-container>
            <label>类型</label>
            <select
              clrSelect
              [ngModel]="resourceType()"
              (ngModelChange)="resourceType.set($event)"
            >
              @for (type of resourceTypes; track type) {
                <option [value]="type">{{ resourceLabel(type) }}</option>
              }
            </select>
          </clr-select-container>
          <clr-input-container>
            <label>依赖 ID</label>
            <input
              clrInput
              [ngModel]="dependencyText()"
              (ngModelChange)="dependencyText.set($event)"
              placeholder="逗号分隔"
            />
          </clr-input-container>
          <button class="btn" type="button" (click)="addResource()">添加资源</button>
        </div>

        <div class="item-list">
          @for (resource of draft().resources; track resource.id) {
            <article class="item-row">
              <div>
                <strong>{{ resource.name }}</strong>
                <span>{{ resource.id }} · {{ resourceLabel(resource.type) }}</span>
              </div>
              <span>依赖：{{ resource.dependencies.join('、') || '无' }}</span>
              <button class="btn btn-sm btn-link" type="button" (click)="removeResource(resource.id)">
                移除
              </button>
            </article>
          } @empty {
            <p class="empty">尚未添加资源。</p>
          }
        </div>
      </section>

      <section class="form-surface">
        <div class="section-heading">
          <span>03</span>
          <div>
            <h2>步骤与回滚</h2>
            <p>回滚步骤必须包含责任人和可执行命令。</p>
          </div>
        </div>
        <div class="step-grid">
          <clr-input-container>
            <label>步骤名称</label>
            <input clrInput [ngModel]="stepTitle()" (ngModelChange)="stepTitle.set($event)" />
          </clr-input-container>
          <clr-select-container>
            <label>阶段</label>
            <select clrSelect [ngModel]="stepPhase()" (ngModelChange)="stepPhase.set($event)">
              <option value="prepare">准备</option>
              <option value="execute">执行</option>
              <option value="verify">验证</option>
              <option value="rollback">回滚</option>
            </select>
          </clr-select-container>
          <clr-input-container>
            <label>责任人</label>
            <input clrInput [ngModel]="stepOwner()" (ngModelChange)="stepOwner.set($event)" />
          </clr-input-container>
          <clr-input-container>
            <label>命令或操作</label>
            <input clrInput [ngModel]="stepCommand()" (ngModelChange)="stepCommand.set($event)" />
          </clr-input-container>
          <button class="btn" type="button" (click)="addStep()">添加步骤</button>
        </div>

        <div class="item-list">
          @for (step of draft().steps; track step.id) {
            <article class="item-row">
              <div>
                <strong>{{ step.title }}</strong>
                <span>{{ phaseLabel(step.phase) }} · {{ step.owner || '未指定责任人' }}</span>
              </div>
              <code>{{ step.command || '缺少命令' }}</code>
              <button class="btn btn-sm btn-link" type="button" (click)="removeStep(step.id)">
                移除
              </button>
            </article>
          } @empty {
            <p class="empty">尚未添加步骤。</p>
          }
        </div>
      </section>

      <section class="form-surface">
        <div class="section-heading">
          <span>04</span>
          <div>
            <h2>执行窗口</h2>
            <p>窗口会用于资源冲突和关键服务观察期检查。</p>
          </div>
        </div>
        <div class="form-grid window-grid">
          <clr-input-container>
            <label>开始时间</label>
            <input
              clrInput
              type="datetime-local"
              [ngModel]="draft().window.start"
              (ngModelChange)="updateWindow('start', $event)"
            />
          </clr-input-container>
          <clr-input-container>
            <label>结束时间</label>
            <input
              clrInput
              type="datetime-local"
              [ngModel]="draft().window.end"
              (ngModelChange)="updateWindow('end', $event)"
            />
          </clr-input-container>
          <clr-input-container>
            <label>观察窗口（分钟）</label>
            <input
              clrNumberInput
              type="number"
              min="0"
              [ngModel]="draft().window.observationWindowMinutes"
              (ngModelChange)="updateObservation($event)"
            />
          </clr-input-container>
        </div>
      </section>

      <section class="form-surface">
        <div class="section-heading">
          <span>05</span>
          <div>
            <h2>提交前校验</h2>
            <p>阻断项未清零时仍可保存草稿，但会阻止进入会签。</p>
          </div>
        </div>
        <app-validation-panel [change]="draft()" [allChanges]="allChanges()" />
      </section>
    </div>

    <footer class="action-bar">
      <button class="btn" type="button" (click)="cancel()">取消</button>
      <button class="btn btn-primary" type="button" (click)="save(true)" [disabled]="!!blockers()">
        保存并提交审批
      </button>
      <button class="btn" type="button" (click)="save(false)">保存草稿</button>
    </footer>
  `,
  styles: [
    `
      :host {
        display: block;
        padding-bottom: 90px;
      }

      .page-heading {
        margin-bottom: 22px;
      }

      .eyebrow {
        margin: 0;
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      h1 {
        margin: 5px 0 8px;
        font-size: 28px;
      }

      .page-heading p:last-child {
        margin: 0;
        color: #5f5f5f;
      }

      .editor-layout {
        display: grid;
        gap: 18px;
      }

      .form-surface {
        padding: 20px;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .section-heading {
        display: flex;
        gap: 14px;
        margin-bottom: 20px;
        padding-bottom: 14px;
        border-bottom: 1px solid #e3e3e3;
      }

      .section-heading > span {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        background: #eef3f6;
        color: #266c91;
        font-size: 12px;
        font-weight: 700;
      }

      h2 {
        margin: 0;
        font-size: 17px;
      }

      .section-heading p {
        margin: 3px 0 0;
        color: #6b6b6b;
        font-size: 12px;
      }

      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px 24px;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .inline-form,
      .step-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(130px, 1fr));
        align-items: end;
        gap: 12px;
        margin-bottom: 18px;
      }

      .step-grid {
        grid-template-columns: repeat(5, minmax(130px, 1fr));
      }

      .item-list {
        border-top: 1px solid #e0e0e0;
      }

      .item-row {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) minmax(180px, 1fr) auto;
        align-items: center;
        gap: 18px;
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .item-row div {
        display: flex;
        flex-direction: column;
      }

      .item-row span {
        color: #606060;
        font-size: 12px;
      }

      code {
        overflow: hidden;
        color: #404040;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .empty {
        padding: 18px 0;
        color: #777;
      }

      .action-bar {
        position: sticky;
        bottom: 0;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin: 20px -24px -24px;
        padding: 14px 24px;
        border-top: 1px solid #d7d7d7;
        background: #fff;
        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
      }

      @media (max-width: 980px) {
        .inline-form,
        .step-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      @media (max-width: 640px) {
        .form-grid,
        .inline-form,
        .step-grid {
          grid-template-columns: 1fr;
        }

        .item-row {
          grid-template-columns: 1fr;
        }

        .action-bar {
          flex-wrap: wrap;
        }
      }
    `,
  ],
})
export class NewChangeComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  readonly allChanges = this.store.selectSignal(selectAllChanges);
  readonly draft = signal<ChangeRequest>(createEmptyChange());
  readonly resourceId = signal('');
  readonly resourceName = signal('');
  readonly resourceType = signal<ResourceType>('service');
  readonly dependencyText = signal('');
  readonly stepTitle = signal('');
  readonly stepPhase = signal<StepPhase>('execute');
  readonly stepOwner = signal('');
  readonly stepCommand = signal('');
  readonly resourceTypes: ResourceType[] = ['datacenter', 'rack', 'network', 'storage', 'service'];

  readonly blockers = computed(
    () =>
      validateChange(this.draft(), this.allChanges()).some(
        (issue) => issue.severity === 'blocker',
      ) ||
      this.draft().resources.length === 0 ||
      this.draft().steps.length === 0,
  );

  onCallText(): string {
    return this.draft().onCall.join('、');
  }

  update<K extends keyof ChangeRequest>(key: K, value: ChangeRequest[K]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  updateWindow(
    key: 'start' | 'end',
    value: string,
  ): void {
    this.draft.update((draft) => ({
      ...draft,
      window: { ...draft.window, [key]: value },
    }));
  }

  updateObservation(value: string | number): void {
    this.draft.update((draft) => ({
      ...draft,
      window: { ...draft.window, observationWindowMinutes: Number(value) || 0 },
    }));
  }

  setOnCall(value: string): void {
    this.update(
      'onCall',
      value
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  addResource(): void {
    const name = this.resourceName().trim();
    if (!name) {
      return;
    }
    const id = this.resourceId().trim() || name.toLowerCase().replace(/\s+/g, '-');
    this.draft.update((draft) => ({
      ...draft,
      resources: [
        ...draft.resources,
        {
          id,
          name,
          type: this.resourceType(),
          critical: false,
          dependencies: this.dependencyText()
            .split(/[、,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
      ],
    }));
    this.resourceId.set('');
    this.resourceName.set('');
    this.dependencyText.set('');
  }

  removeResource(id: string): void {
    this.draft.update((draft) => ({
      ...draft,
      resources: draft.resources.filter((resource) => resource.id !== id),
    }));
  }

  addStep(): void {
    const title = this.stepTitle().trim();
    if (!title) {
      return;
    }
    const step: ChangeStep = {
      id: `step-${Date.now()}`,
      phase: this.stepPhase(),
      title,
      owner: this.stepOwner().trim(),
      durationMinutes: 15,
      command: this.stepCommand().trim(),
      completed: false,
    };
    this.draft.update((draft) => ({ ...draft, steps: [...draft.steps, step] }));
    this.stepTitle.set('');
    this.stepOwner.set('');
    this.stepCommand.set('');
  }

  removeStep(id: string): void {
    this.draft.update((draft) => ({
      ...draft,
      steps: draft.steps.filter((step) => step.id !== id),
    }));
  }

  resourceLabel(type: ResourceType): string {
    return RESOURCE_LABELS[type];
  }

  phaseLabel(phase: StepPhase): string {
    return {
      prepare: '准备',
      execute: '执行',
      verify: '验证',
      rollback: '回滚',
    }[phase];
  }

  save(submit: boolean): void {
    const draft = {
      ...this.draft(),
      approvals: APPROVAL_ORDER.map((stage) => ({ stage, state: 'pending' as const })),
    };
    this.store.dispatch(ChangeRequestActions.createChange({ change: draft }));
    if (submit) {
      this.store.dispatch(ChangeRequestActions.submitForReview({ id: draft.id }));
    }
    void this.router.navigate(['/changes', draft.id]);
  }

  cancel(): void {
    void this.router.navigate(['/']);
  }
}
