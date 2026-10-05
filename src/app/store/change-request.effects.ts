import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, filter, map, of, switchMap, withLatestFrom } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import { DrillBatch } from '../models/rollback-drill.model';
import { ChangeRequestService } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges } from './change-request.selectors';

interface DrillJournalEntry {
  id: string;
  batch: DrillBatch;
}

/**
 * 定位本次动作对应的完整演练批次，作为写入失败后的恢复依据。
 * 提交动作在 reducer 中生成批次，这里取该方案最新批次。
 */
function drillJournalTarget(
  action: { type: string; id?: string; batchId?: string; batch?: DrillBatch },
  changes: ChangeRequest[],
): DrillJournalEntry | null {
  const change = changes.find((item) => item.id === action.id);
  if (!change) {
    return null;
  }
  if (action.type === ChangeRequestActions.recoverDrillBatch.type) {
    return action.batch ? { id: change.id, batch: action.batch } : null;
  }
  if (action.type === ChangeRequestActions.submitDrillBatch.type) {
    const batch = [...change.drillBatches].sort((left, right) => right.sequence - left.sequence)[0];
    return batch ? { id: change.id, batch } : null;
  }
  if (
    action.type === ChangeRequestActions.startDrillBatch.type ||
    action.type === ChangeRequestActions.completeDrillBatch.type
  ) {
    const batch = change.drillBatches.find((item) => item.id === action.batchId);
    return batch ? { id: change.id, batch } : null;
  }
  return null;
}

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.service.load().pipe(
          map((changes) => ChangeRequestActions.loadChangesSuccess({ changes })),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  // 上次写入失败留下的完整演练批次，在数据加载后重放恢复
  restoreDrillJournal$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChangesSuccess),
      map(() => this.service.readDrillJournal()),
      filter((journal): journal is DrillJournalEntry => journal !== null),
      map((journal) => ChangeRequestActions.recoverDrillBatch(journal)),
    ),
  );

  persistChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.createChange,
        ChangeRequestActions.updateChange,
        ChangeRequestActions.deleteDraft,
        ChangeRequestActions.submitForReview,
        ChangeRequestActions.approveStage,
        ChangeRequestActions.rejectStage,
        ChangeRequestActions.startExecution,
        ChangeRequestActions.toggleStep,
        ChangeRequestActions.recordDeviation,
        ChangeRequestActions.completeExecution,
        ChangeRequestActions.submitDrillBatch,
        ChangeRequestActions.startDrillBatch,
        ChangeRequestActions.completeDrillBatch,
        ChangeRequestActions.recoverDrillBatch,
      ),
      withLatestFrom(this.store.select(selectAllChanges)),
      map(([action, changes]) => {
        const journal = drillJournalTarget(action, changes);
        if (journal) {
          this.service.writeDrillJournal(journal.id, journal.batch);
        }
        const saved = this.service.save(changes);
        if (saved) {
          if (journal || action.type === ChangeRequestActions.recoverDrillBatch.type) {
            this.service.clearDrillJournal();
          }
          return null;
        }
        // 写入失败：从完整演练批次恢复；恢复动作自身失败不再重放，避免循环
        if (journal && action.type !== ChangeRequestActions.recoverDrillBatch.type) {
          return ChangeRequestActions.recoverDrillBatch(journal);
        }
        return null;
      }),
      filter(
        (action): action is ReturnType<typeof ChangeRequestActions.recoverDrillBatch> =>
          action !== null,
      ),
    ),
  );
}
