import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChangeRequest } from '../models/change-request.model';
import {
  DrillBatch,
  DrillRecord,
  evaluateExecutionGate,
  findQueueBlockers,
  isCredentialCurrent,
  PlanVersion,
  ReleaseCredential,
} from '../models/rollback-drill.model';
import { selectAllChanges } from './change-request.selectors';
import { RollbackDrillState } from './rollback-drill.reducer';

export const selectRollbackDrillState = createFeatureSelector<RollbackDrillState>('rollbackDrills');

export const selectVersions = createSelector(
  selectRollbackDrillState,
  (state): Record<string, PlanVersion> => state.versions,
);

export const selectDrills = createSelector(selectRollbackDrillState, (state): DrillRecord[] =>
  Object.values(state.drills).sort((left, right) =>
    left.batch.order === right.batch.order
      ? left.batch.requestedAt.localeCompare(right.batch.requestedAt)
      : left.batch.order - right.batch.order,
  ),
);

export const selectCredentials = createSelector(
  selectRollbackDrillState,
  (state): Record<string, ReleaseCredential> => state.credentials,
);

export const selectDrillNotice = createSelector(selectRollbackDrillState, (state) => state.notice);

export const selectUnpersistedBatches = createSelector(selectRollbackDrillState, (state) =>
  Object.values(state.unpersistedBatches).sort((a, b) => a.order - b.order),
);

export const selectVersionByChangeId = (changeId: string) =>
  createSelector(selectVersions, (versions) => versions[changeId]);

export const selectDrillsByChangeId = (changeId: string) =>
  createSelector(selectDrills, (drills) => drills.filter((drill) => drill.changeId === changeId));

/** 当前与方案版本匹配的有效凭证（旧版本凭证保留但不放行） */
export const selectCurrentCredentialByChangeId = (changeId: string) =>
  createSelector(selectCredentials, selectVersionByChangeId(changeId), (credentials, version) =>
    Object.values(credentials).find(
      (credential) => credential.changeId === changeId && isCredentialCurrent(credential, version),
    ),
  );

export interface ExecutionGateView {
  allowed: boolean;
  reason: string;
  credentialId?: string;
  credential?: ReleaseCredential;
  version?: PlanVersion;
}

export const selectExecutionGateByChangeId = (changeId: string) =>
  createSelector(
    selectAllChanges,
    selectVersions,
    selectCredentials,
    (changes: ChangeRequest[], versions, credentials): ExecutionGateView => {
      const change = changes.find((item) => item.id === changeId);
      if (!change) {
        return { allowed: false, reason: '变更不存在。' };
      }
      const version = versions[changeId];
      const credential = Object.values(credentials).find(
        (item) =>
          item.changeId === changeId &&
          item.status === 'issued' &&
          item.fingerprint === version?.fingerprint,
      );
      const gate = evaluateExecutionGate(change, version, credential);
      return {
        ...gate,
        credentialId: credential?.id,
        credential,
        version,
      };
    },
  );

/** 旧方案凭证待补列表：版本为 legacy_backfill 且没有当前凭证 */
export const selectBackfillQueue = createSelector(
  selectAllChanges,
  selectVersions,
  selectCredentials,
  (changes, versions, credentials) =>
    changes
      .filter((change) => !['draft', 'rejected'].includes(change.status))
      .filter((change) => versions[change.id]?.gateState === 'legacy_backfill')
      .filter(
        (change) =>
          !Object.values(credentials).some(
            (credential) =>
              credential.changeId === change.id &&
              credential.status === 'issued' &&
              credential.fingerprint === versions[change.id].fingerprint,
          ),
      ),
);

export const selectLegacyBackfillCount = createSelector(
  selectBackfillQueue,
  (queue) => queue.length,
);

/**
 * 排队批次实时视图：阻塞项随共享资源占用情况重算。
 * 当占用资源的正式变更/先到演练释放资源后，后到批次自动解除阻塞。
 */
export interface DrillQueueView {
  drill: DrillRecord;
  liveBlockers: DrillBatch['blockedBy'];
  ready: boolean;
}

export const selectDrillQueueViews = createSelector(
  selectDrills,
  selectAllChanges,
  (drills, changes): DrillQueueView[] =>
    drills.map((drill) => {
      const liveBlockers =
        drill.status === 'queued'
          ? findQueueBlockers(drill.batch.planSnapshot, changes, drills, { selfId: drill.id })
          : drill.batch.blockedBy;
      return { drill, liveBlockers, ready: drill.status === 'queued' && liveBlockers.length === 0 };
    }),
);

export const selectDrillQueueViewsByChangeId = (changeId: string) =>
  createSelector(selectDrillQueueViews, (views) =>
    views.filter((view) => view.drill.changeId === changeId),
  );
