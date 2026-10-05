import { Injectable } from '@angular/core';
import { DrillRecord, PlanVersion, ReleaseCredential } from '../models/rollback-drill.model';

const STORAGE_KEY = 'pair-wise-gsb-69-rollback-drills';

export interface RollbackDrillPersisted {
  versions: PlanVersion[];
  drills: DrillRecord[];
  credentials: ReleaseCredential[];
}

@Injectable({ providedIn: 'root' })
export class RollbackDrillService {
  /** 演练用故障开关：置位后下一次 save 抛错，模拟批次写入失败 */
  failNextWrites = false;

  load(): RollbackDrillPersisted | null {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (!localValue) {
      return null;
    }
    try {
      const parsed = JSON.parse(localValue) as RollbackDrillPersisted;
      return {
        versions: parsed.versions ?? [],
        drills: parsed.drills ?? [],
        credentials: parsed.credentials ?? [],
      };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  save(state: RollbackDrillPersisted): void {
    if (this.failNextWrites) {
      throw new Error('隔离链路批次存储写入失败（演练注入故障）');
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      throw new Error(
        `演练批次写入失败：${error instanceof Error ? error.message : '本地存储不可用'}`,
      );
    }
  }

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
