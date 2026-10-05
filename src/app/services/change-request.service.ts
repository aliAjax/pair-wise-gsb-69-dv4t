import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, tap } from 'rxjs';
import { ChangeRequest, migrateChange } from '../models/change-request.model';
import { DrillBatch } from '../models/rollback-drill.model';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';
const DRILL_JOURNAL_KEY = 'pair-wise-gsb-69-drill-journal';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      try {
        return of((JSON.parse(localValue) as ChangeRequest[]).map((change) => migrateChange(change)));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      map((changes) => changes.map((change) => migrateChange(change))),
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  save(changes: ChangeRequest[]): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
      return true;
    } catch (error: unknown) {
      console.error('Failed to persist change requests', error);
      return false;
    }
  }

  /**
   * 演练批次写前日志：主存储写入失败时，凭完整批次恢复，
   * 重放按批次 id 归并，不新增凭证。
   */
  writeDrillJournal(id: string, batch: DrillBatch): void {
    try {
      localStorage.setItem(DRILL_JOURNAL_KEY, JSON.stringify({ id, batch }));
    } catch (error: unknown) {
      console.error('Failed to write drill journal', error);
    }
  }

  readDrillJournal(): { id: string; batch: DrillBatch } | null {
    const value = localStorage.getItem(DRILL_JOURNAL_KEY);
    if (!value) {
      return null;
    }
    try {
      return JSON.parse(value) as { id: string; batch: DrillBatch };
    } catch {
      localStorage.removeItem(DRILL_JOURNAL_KEY);
      return null;
    }
  }

  clearDrillJournal(): void {
    localStorage.removeItem(DRILL_JOURNAL_KEY);
  }

  exportRetrospective(change: ChangeRequest): string {
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      `方案版本：v${change.planVersion}`,
      `演练凭证：${change.activeCredential ? change.activeCredential.id : '待补'}`,
      '',
      '## 演练批次',
      ...(change.drillBatches.length
        ? change.drillBatches.map(
            (batch) =>
              `- ${batch.id} [${batch.status}] 方案 v${batch.planVersion} ${batch.operator}` +
              (batch.credential ? ` 凭证 ${batch.credential.id}` : ''),
          )
        : ['- 无']),
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
