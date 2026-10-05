import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ChangeRequest,
  ValidationIssue,
  validateChange,
} from '../../models/change-request.model';

@Component({
  selector: 'app-validation-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="validation-header" [class.clear]="!issues().length">
      <div>
        <strong>{{ issues().length ? '存在待处理项' : '校验通过' }}</strong>
        <span>
          @if (issues().length) {
            {{ blockers() }} 个阻断项，{{ warnings() }} 个警告
          } @else {
            可提交审批
          }
        </span>
      </div>
      <span class="status-dot"></span>
    </div>

    @for (issue of issues(); track issue.id) {
      <article class="issue" [class.warning]="issue.severity === 'warning'">
        <div class="issue-title">
          <span class="severity">{{ issue.severity === 'blocker' ? '阻断' : '警告' }}</span>
          <strong>{{ issue.title }}</strong>
        </div>
        <p>{{ issue.detail }}</p>
        <div class="suggested">建议：{{ issue.suggestedAction }}</div>
      </article>
    }
  `,
  styles: [
    `
      .validation-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border: 1px solid #ea9a86;
        background: #fae7e2;
      }

      .validation-header.clear {
        border-color: #8ec9a3;
        background: #e9f6ed;
      }

      .validation-header div {
        display: flex;
        flex-direction: column;
      }

      .validation-header span {
        margin-top: 3px;
        color: #666;
        font-size: 12px;
      }

      .status-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #c21d00;
      }

      .clear .status-dot {
        background: #2f7d4a;
      }

      .issue {
        padding: 16px;
        border: 1px solid #d7d7d7;
        border-top: 0;
        background: #fff;
      }

      .issue.warning {
        border-left: 3px solid #d99000;
      }

      .issue-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .severity {
        padding: 2px 6px;
        background: #c21d00;
        color: #fff;
        font-size: 10px;
      }

      .warning .severity {
        background: #a96800;
      }

      p {
        margin: 9px 0;
        color: #4c4c4c;
        line-height: 1.6;
      }

      .suggested {
        color: #266c91;
        font-size: 12px;
      }
    `,
  ],
})
export class ValidationPanelComponent {
  readonly change = input.required<ChangeRequest>();
  readonly allChanges = input.required<ChangeRequest[]>();

  readonly issues = computed(() => validateChange(this.change(), this.allChanges()));
  readonly blockers = computed(
    () => this.issues().filter((issue) => issue.severity === 'blocker').length,
  );
  readonly warnings = computed(
    () => this.issues().filter((issue) => issue.severity === 'warning').length,
  );
}
