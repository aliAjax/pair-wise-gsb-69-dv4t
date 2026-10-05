import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChangeRequest, STATUS_LABELS } from '../../models/change-request.model';

interface GanttRow {
  id: string;
  title: string;
  owner: string;
  status: string;
  left: number;
  width: number;
  conflicts: boolean;
}

@Component({
  selector: 'app-window-gantt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gantt-shell">
      <div class="axis">
        @for (day of days; track day) {
          <span>{{ day }}</span>
        }
      </div>
      <div class="rows">
        @for (row of rows(); track row.id) {
          <div class="gantt-row" [class.active]="row.id === selectedId()">
            <div class="row-label">
              <strong>{{ row.title }}</strong>
              <span>{{ row.id }} · {{ row.owner }}</span>
            </div>
            <div class="track">
              <div
                class="bar"
                [class.conflict]="row.conflicts"
                [style.left.%]="row.left"
                [style.width.%]="row.width"
                [title]="row.status"
              >
                {{ row.status }}
              </div>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .gantt-shell {
        border: 1px solid #d7d7d7;
        background: #ffffff;
        overflow: hidden;
      }

      .axis {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        margin-left: 230px;
        border-bottom: 1px solid #d7d7d7;
        background: #f2f4f6;
      }

      .axis span {
        padding: 10px 12px;
        border-left: 1px solid #d7d7d7;
        font-size: 12px;
        color: #555;
      }

      .gantt-row {
        display: grid;
        grid-template-columns: 230px 1fr;
        min-height: 68px;
        border-bottom: 1px solid #e5e5e5;
      }

      .gantt-row:last-child {
        border-bottom: 0;
      }

      .gantt-row.active {
        background: #f0f7fb;
      }

      .row-label {
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 8px 16px;
      }

      .row-label strong {
        color: #1b1b1b;
        font-size: 13px;
      }

      .row-label span {
        margin-top: 4px;
        color: #707070;
        font-size: 11px;
      }

      .track {
        position: relative;
        margin: 15px 16px;
        height: 36px;
        border-left: 1px solid #d7d7d7;
        background: repeating-linear-gradient(
          to right,
          #f2f4f6,
          #f2f4f6 calc(25% - 1px),
          #d7d7d7 25%
        );
      }

      .bar {
        position: absolute;
        top: 4px;
        height: 28px;
        min-width: 28px;
        padding: 5px 8px;
        box-sizing: border-box;
        border-left: 4px solid #266c91;
        background: #c8e3f2;
        color: #174d6a;
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bar.conflict {
        border-left-color: #c21d00;
        background: #f2c9c1;
        color: #7f1808;
      }
    `,
  ],
})
export class WindowGanttComponent {
  readonly changes = input.required<ChangeRequest[]>();
  readonly selectedId = input<string>('');
  readonly days = ['09-29 周二', '09-30 周三', '10-01 周四', '10-02 周五'];

  readonly rows = computed<GanttRow[]>(() => {
    const start = new Date('2026-09-29T00:00:00').getTime();
    const total = 4 * 24 * 60;
    const changes = this.changes();

    return changes.map((change) => {
      const leftMinutes = (new Date(change.window.start).getTime() - start) / 60_000;
      const duration =
        (new Date(change.window.end).getTime() - new Date(change.window.start).getTime()) /
        60_000;
      const conflicts = changes.some(
        (candidate) =>
          candidate.id !== change.id &&
          !['draft', 'rejected', 'rolled_back'].includes(candidate.status) &&
          change.resources.some((resource) =>
            candidate.resources.some((candidateResource) => candidateResource.id === resource.id),
          ) &&
          new Date(change.window.start) < new Date(candidate.window.end) &&
          new Date(candidate.window.start) < new Date(change.window.end),
      );

      return {
        id: change.id,
        title: change.title,
        owner: change.owner,
        status: STATUS_LABELS[change.status],
        left: Math.max(0, Math.min(98, (leftMinutes / total) * 100)),
        width: Math.max(2, Math.min(100, (duration / total) * 100)),
        conflicts,
      };
    });
  });
}
