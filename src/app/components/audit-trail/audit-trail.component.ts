import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AuditRecord } from '../../models/change-request.model';

@Component({
  selector: 'app-audit-trail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <ol class="audit-list">
      @for (item of records(); track item.id) {
        <li>
          <div class="marker"></div>
          <div class="record">
            <div class="record-head">
              <strong>{{ item.action }}</strong>
              <time>{{ item.timestamp | date: 'yyyy-MM-dd HH:mm' }}</time>
            </div>
            <p>{{ item.detail }}</p>
            <span>{{ item.actor }}</span>
          </div>
        </li>
      } @empty {
        <li class="empty">暂无审计记录</li>
      }
    </ol>
  `,
  styles: [
    `
      .audit-list {
        margin: 0;
        padding: 8px 0 8px 20px;
        list-style: none;
      }

      li {
        position: relative;
        padding: 0 0 24px 24px;
        border-left: 1px solid #bdc7d0;
      }

      li:last-child {
        border-left-color: transparent;
      }

      .marker {
        position: absolute;
        left: -5px;
        top: 4px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #266c91;
      }

      .record {
        margin-left: 7px;
      }

      .record-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }

      time,
      .record span {
        color: #6b6b6b;
        font-size: 12px;
      }

      p {
        margin: 7px 0 4px;
        color: #414141;
      }

      .empty {
        border-left: 0;
        color: #737373;
      }
    `,
  ],
})
export class AuditTrailComponent {
  readonly records = input.required<AuditRecord[]>();
}
