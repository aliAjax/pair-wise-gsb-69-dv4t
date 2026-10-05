import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { map, tap, withLatestFrom, concatMap, take } from 'rxjs';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges } from './change-request.selectors';
import {
  checkSubmissionPrerequisites,
  findActiveDrillForVersion,
  findQueueBlockers,
} from '../models/rollback-drill.model';
import { RollbackDrillService } from '../services/rollback-drill.service';
import { buildDrillSubmission } from './drill-factory';
import { RollbackDrillActions } from './rollback-drill.actions';
import { RollbackDrillState } from './rollback-drill.reducer';
import {
  selectDrills,
  selectExecutionGateByChangeId,
  selectVersions,
} from './rollback-drill.selectors';

@Injectable()
export class RollbackDrillEffects {
  private readonly actions$ = inject(Actions);
  private readonly store = inject(Store);
  private readonly service = inject(RollbackDrillService);

  /** 变更数据首次加载完成后，载入演练版本、批次与凭证 */
  hydrate$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChangesSuccess),
      map(({ changes }) => {
        const persisted = this.service.load();
        return RollbackDrillActions.hydrate({
          changes,
          versions: persisted?.versions ?? [],
          drills: persisted?.drills ?? [],
          credentials: persisted?.credentials ?? [],
        });
      }),
    ),
  );

  /**
   * 提交演练：
   * - 前置条件不满足 → 拒绝（不进入批次）；
   * - 同 clientToken 重放 → 幂等拒绝，不新增演练/凭证；
   * - 同版本已有生效演练 → 先到生效，后到保留冲突；
   * - 否则按共享资源计算排队：有占用即 queued，资源空闲直接 running。
   */
  submitDrill$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RollbackDrillActions.submitDrill),
      withLatestFrom(
        this.store.select(selectAllChanges),
        this.store.select(selectDrills),
        this.store.select(selectVersions),
        this.store.select(
          (state: { rollbackDrills: RollbackDrillState }) => state.rollbackDrills.orderSequence,
        ),
      ),
      map(([{ input }, changes, drills, versions, orderSequence]) => {
        const change = changes.find((item) => item.id === input.change.id);
        if (!change) {
          return RollbackDrillActions.submitDrillRejected({
            changeId: input.change.id,
            reason: '变更不存在。',
          });
        }

        if (drills.some((drill) => drill.batch.clientToken === input.clientToken)) {
          return RollbackDrillActions.submitDrillRejected({
            changeId: change.id,
            reason: '相同提交令牌已处理，重复提交不新增演练与凭证。',
          });
        }

        const prerequisites = checkSubmissionPrerequisites(change);
        if (!prerequisites.ok) {
          return RollbackDrillActions.submitDrillRejected({
            changeId: change.id,
            reason: prerequisites.reason,
          });
        }

        const version = versions[change.id];
        const fingerprint = version?.fingerprint ?? change.id;
        const winner = findActiveDrillForVersion(drills, change.id, fingerprint);
        const timestamp = new Date().toISOString();

        if (winner) {
          // 先到生效：后到的提交保留为冲突记录，不占用资源、不签发凭证
          const retainedDrill = buildDrillSubmission({
            change,
            submittedBy: input.submittedBy,
            clientToken: input.clientToken,
            order: orderSequence + 1,
            status: 'conflict_retained',
            blockedBy: [
              {
                kind: 'prior_drill',
                holderId: winner.id,
                changeId: winner.changeId,
                holderLabel: `批次 ${winner.batch.id}（${winner.submittedBy}）`,
                resourceIds: [],
              },
            ],
            replayed: false,
            timestamp,
            version,
            invalidReason: `与先到的批次 ${winner.batch.id} 并发提交，先到已生效，本次保留冲突。`,
          });
          return RollbackDrillActions.submitDrillConflict({
            changeId: change.id,
            reason: `${input.submittedBy} 的提交与 ${winner.submittedBy} 先到的批次 ${winner.batch.id} 冲突：先到生效，本次保留冲突。`,
            winnerId: winner.id,
            retainedDrill,
          });
        }

        const blockers = findQueueBlockers(change, changes, drills);
        const drill = buildDrillSubmission({
          change,
          submittedBy: input.submittedBy,
          clientToken: input.clientToken,
          order: orderSequence + 1,
          status: blockers.length > 0 ? 'queued' : 'running',
          blockedBy: blockers,
          replayed: false,
          timestamp,
          version,
        });
        return RollbackDrillActions.submitDrillAccepted({ drill });
      }),
    ),
  );

  /** 后到的并发提交保留冲突记录并落库 */
  persistConflict$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RollbackDrillActions.submitDrillConflict),
      map(({ retainedDrill }) =>
        RollbackDrillActions.retainConflictDrill({ drill: retainedDrill }),
      ),
    ),
  );

  /**
   * 开始执行门禁：只有与当前方案版本一致的凭证才能放行。
   * 旧方案待补、缺凭证、凭证属旧版本时阻断。
   */
  startExecutionGate$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.startExecution),
      map((action) => action.id),
      concatMap((id) =>
        this.store.select(selectExecutionGateByChangeId(id)).pipe(
          take(1),
          map((gate) =>
            gate.allowed && gate.credentialId
              ? ChangeRequestActions.executionReleased({ id, credentialId: gate.credentialId })
              : ChangeRequestActions.executionBlocked({ id, reason: gate.reason }),
          ),
        ),
      ),
    ),
  );

  /** 占用资源的批次启动/结束，或正式变更完成后，重算排队阻塞 */
  refreshQueue$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        RollbackDrillActions.submitDrillAccepted,
        RollbackDrillActions.startBatch,
        RollbackDrillActions.completeBatch,
        ChangeRequestActions.completeExecution,
      ),
      withLatestFrom(this.store.select(selectAllChanges)),
      map(([, changes]) => RollbackDrillActions.refreshQueue({ changes })),
    ),
  );

  /** 变更保存/会签后校准方案版本（未执行演练随拓扑/命令/窗口作废） */
  reconcile$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.updateChange,
        ChangeRequestActions.submitForReview,
        ChangeRequestActions.approveStage,
        ChangeRequestActions.rejectStage,
        ChangeRequestActions.completeExecution,
      ),
      withLatestFrom(this.store.select(selectAllChanges)),
      map(([, changes]) => RollbackDrillActions.reconcilePlanVersions({ changes })),
    ),
  );

  /** 批次/版本变化后持久化；写入失败发出告警，完整批次保留在内存中用于恢复 */
  persist$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(
          RollbackDrillActions.submitDrillAccepted,
          RollbackDrillActions.retainConflictDrill,
          RollbackDrillActions.startBatch,
          RollbackDrillActions.completeBatch,
          RollbackDrillActions.refreshQueue,
          RollbackDrillActions.reconcilePlanVersions,
          RollbackDrillActions.hydrate,
          RollbackDrillActions.recoverFromBatch,
        ),
        withLatestFrom(
          this.store.select(
            (state: { rollbackDrills: RollbackDrillState }) => state.rollbackDrills,
          ),
        ),
        tap(([, drillState]) => {
          try {
            this.service.save({
              versions: Object.values(drillState.versions),
              drills: Object.values(drillState.drills),
              credentials: Object.values(drillState.credentials),
            });
          } catch (error) {
            this.store.dispatch(
              RollbackDrillActions.persistFailure({
                error: error instanceof Error ? error.message : '演练批次写入失败',
              }),
            );
          }
        }),
      ),
    { dispatch: false },
  );
}
