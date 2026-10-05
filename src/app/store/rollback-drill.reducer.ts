import { createReducer, on } from '@ngrx/store';
import { ChangeRequest } from '../models/change-request.model';
import { ChangeRequestActions } from './change-request.actions';
import {
  buildFrozenSnapshot,
  buildPlanVersion,
  DrillBatch,
  DrillRecord,
  findQueueBlockers,
  PlanVersion,
  ReleaseCredential,
} from '../models/rollback-drill.model';
import { RollbackDrillActions } from './rollback-drill.actions';
import { buildDrillSubmission, credentialIdOf } from './drill-factory';

export interface DrillNotice {
  kind: 'persist_failure' | 'recovered' | 'rejected' | 'conflict' | 'info';
  message: string;
}

export interface RollbackDrillState {
  versions: Record<string, PlanVersion>;
  drills: Record<string, DrillRecord>;
  credentials: Record<string, ReleaseCredential>;
  /** clientToken -> drillId，提交幂等：重复令牌不新增演练与凭证 */
  processedTokens: Record<string, string>;
  orderSequence: number;
  hydrated: boolean;
  /** 自上次成功持久化以来变更过的完整批次（写入失败后据此恢复） */
  unpersistedBatches: Record<string, DrillBatch>;
  notice: DrillNotice | null;
}

export const initialRollbackDrillState: RollbackDrillState = {
  versions: {},
  drills: {},
  credentials: {},
  processedTokens: {},
  orderSequence: 0,
  hydrated: false,
  unpersistedBatches: {},
  notice: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

function markDirty(state: RollbackDrillState, batch: DrillBatch): RollbackDrillState {
  return {
    ...state,
    unpersistedBatches: { ...state.unpersistedBatches, [batch.id]: batch },
  };
}

function rebuildTokens(drills: Record<string, DrillRecord>): Record<string, string> {
  return Object.values(drills).reduce<Record<string, string>>((acc, drill) => {
    acc[drill.batch.clientToken] = drill.id;
    return acc;
  }, {});
}

/**
 * 按当前共享资源占用重算所有排队批次：
 * 正式变更释放资源或先到演练完成后，后到批次的 blockedBy 被清空即可开始。
 */
function refreshQueue(state: RollbackDrillState, changes: ChangeRequest[]): RollbackDrillState {
  const drills = Object.values(state.drills);
  let changed = false;
  const nextDrills = { ...state.drills };

  drills
    .filter((drill) => drill.status === 'queued')
    .forEach((drill) => {
      const liveBlockers = findQueueBlockers(drill.batch.planSnapshot, changes, drills, {
        selfId: drill.id,
      });
      const same =
        liveBlockers.length === drill.batch.blockedBy.length &&
        liveBlockers.every((blocker, index) => {
          const current = drill.batch.blockedBy[index];
          return (
            current &&
            blocker.kind === current.kind &&
            blocker.holderId === current.holderId &&
            blocker.resourceIds.join('|') === current.resourceIds.join('|')
          );
        });
      if (!same) {
        changed = true;
        nextDrills[drill.id] = {
          ...drill,
          batch: { ...drill.batch, blockedBy: liveBlockers },
          updatedAt: nowIso(),
        };
      }
    });

  return changed ? { ...state, drills: nextDrills } : state;
}

/**
 * 方案版本归一化：
 * - 已登记版本：指纹不变则保留；拓扑/命令/窗口变化则升级版本并把未执行演练作废，
 *   已成功演练及其凭证保留在旧版本上；
 * - 未登记版本：存量旧方案标记为凭证待补（legacy_backfill）。
 */
function reconcileVersion(
  state: RollbackDrillState,
  change: ChangeRequest,
  options: { markLegacy: boolean },
): RollbackDrillState {
  const next = buildPlanVersion(change, options.markLegacy ? 'legacy_backfill' : 'active');
  const existing = state.versions[change.id];

  if (!existing) {
    return {
      ...state,
      versions: {
        ...state.versions,
        [change.id]: buildPlanVersion(change, options.markLegacy ? 'legacy_backfill' : 'active'),
      },
    };
  }

  if (existing.fingerprint === next.fingerprint) {
    if (existing.gateState === next.gateState) {
      return state;
    }
    return {
      ...state,
      versions: { ...state.versions, [change.id]: { ...existing, gateState: next.gateState } },
    };
  }

  const invalidatedDrills = Object.values(state.drills).reduce<Record<string, DrillRecord>>(
    (acc, drill) => {
      if (
        drill.changeId === change.id &&
        drill.fingerprint === existing.fingerprint &&
        (drill.status === 'queued' || drill.status === 'running')
      ) {
        acc[drill.id] = {
          ...drill,
          status: 'invalidated',
          invalidReason: `拓扑、回滚命令或窗口已变更为 ${next.versionLabel}，未执行的演练批次 ${drill.batch.id} 作废；已完成演练保留原凭证。`,
          batch: { ...drill.batch, finishedAt: nowIso(), blockedBy: [] },
          updatedAt: nowIso(),
        };
      } else {
        acc[drill.id] = drill;
      }
      return acc;
    },
    {},
  );

  return {
    ...state,
    versions: {
      ...state.versions,
      [change.id]: { ...next, gateState: options.markLegacy ? 'legacy_backfill' : 'active' },
    },
    drills: invalidatedDrills,
  };
}

function reconcileAll(
  state: RollbackDrillState,
  changes: ChangeRequest[],
  options: { markLegacy: boolean },
): RollbackDrillState {
  let next = state;
  const liveIds = new Set(changes.map((change) => change.id));

  changes.forEach((change) => {
    next = reconcileVersion(next, change, options);
  });

  // 清理已删除变更
  let changed = false;
  const versions = Object.fromEntries(
    Object.entries(next.versions).filter(([id]) => {
      const keep = liveIds.has(id);
      if (!keep) {
        changed = true;
      }
      return keep;
    }),
  );
  if (!changed) {
    return next;
  }
  const drills = Object.fromEntries(
    Object.entries(next.drills).filter(([, drill]) => liveIds.has(drill.changeId)),
  );
  const credentials = Object.fromEntries(
    Object.entries(next.credentials).filter(([, credential]) => liveIds.has(credential.changeId)),
  );
  return {
    ...next,
    versions,
    drills,
    credentials,
    processedTokens: rebuildTokens(drills),
  };
}

/**
 * 写入失败后的恢复入口：仅凭一份完整演练批次重建。
 * - 身份（演练 ID、批次 ID、凭证 ID）由 clientToken 与序号确定性生成；
 * - 同批次重复重放直接幂等返回，不新增演练、不新增凭证；
 * - 成功批次按冻结快照补回凭证（若凭证缺失），已存在则沿用原凭证。
 */
function restoreFromBatch(state: RollbackDrillState, batch: DrillBatch): RollbackDrillState {
  const snapshot = batch.planSnapshot;
  const existingId = state.processedTokens[batch.clientToken];
  const existing = existingId ? state.drills[existingId] : undefined;

  const noticeMessage = existing?.batch.replayed
    ? `批次 ${batch.id} 已是恢复状态，重复重放未新增凭证。`
    : `批次 ${batch.id} 已从完整演练批次恢复，重复重放不会新增凭证。`;

  if (existing && existing.batch.replayed) {
    return { ...state, notice: { kind: 'recovered', message: noticeMessage } };
  }

  const restoredStatus: DrillRecord['status'] = batch.outcome
    ? batch.outcome.result === 'success'
      ? 'succeeded'
      : 'failed'
    : batch.startedAt
      ? 'running'
      : 'queued';

  const version =
    state.versions[snapshot.id] ??
    buildPlanVersion(snapshot, existing ? 'active' : 'legacy_backfill');

  const restoredBatch: DrillBatch = {
    ...batch,
    planSnapshot: structuredClone(snapshot),
    replayed: true,
    blockedBy: [],
  };

  const restored: DrillRecord = existing
    ? {
        ...existing,
        status: restoredStatus,
        result: batch.outcome?.result,
        resultNote: batch.outcome?.note,
        batch: restoredBatch,
        credentialId:
          batch.outcome?.result === 'success'
            ? credentialIdOf(snapshot.id, version.fingerprint)
            : existing.credentialId,
        updatedAt: nowIso(),
      }
    : {
        ...buildDrillSubmission({
          change: snapshot,
          submittedBy: snapshot.owner || '恢复任务',
          clientToken: batch.clientToken,
          order: batch.order,
          status: restoredStatus,
          blockedBy: [],
          replayed: true,
          timestamp: batch.requestedAt,
          version,
        }),
        batch: restoredBatch,
      };

  let next: RollbackDrillState = {
    ...state,
    drills: { ...state.drills, [restored.id]: restored },
    versions: state.versions[snapshot.id]
      ? state.versions
      : { ...state.versions, [snapshot.id]: version },
    processedTokens: { ...state.processedTokens, [batch.clientToken]: restored.id },
    orderSequence: Math.max(state.orderSequence, batch.order),
    notice: { kind: 'recovered', message: noticeMessage },
  };

  if (batch.outcome?.result === 'success') {
    const credentialId = credentialIdOf(snapshot.id, version.fingerprint);
    const credential: ReleaseCredential | undefined = state.credentials[credentialId];
    if (!credential) {
      const issuedAt = batch.outcome.at ?? batch.finishedAt ?? nowIso();
      next = {
        ...next,
        credentials: {
          ...next.credentials,
          [credentialId]: {
            id: credentialId,
            changeId: snapshot.id,
            fingerprint: version.fingerprint,
            versionLabel: version.versionLabel,
            drillId: restored.id,
            batchId: restoredBatch.id,
            issuedBy: restored.submittedBy,
            issuedAt,
            status: 'issued',
            frozen: buildFrozenSnapshot(snapshot, version, issuedAt),
          },
        },
      };
    }
  }

  return markDirty(next, restoredBatch);
}

export const rollbackDrillReducer = createReducer(
  initialRollbackDrillState,

  on(RollbackDrillActions.hydrate, (state, { changes, versions, drills, credentials }) => {
    const rebuiltDrills = Object.fromEntries(drills.map((drill) => [drill.id, drill]));
    const merged: RollbackDrillState = {
      ...state,
      versions: Object.fromEntries(versions.map((version) => [version.changeId, version])),
      drills: rebuiltDrills,
      credentials: Object.fromEntries(credentials.map((credential) => [credential.id, credential])),
      orderSequence: drills.reduce((max, drill) => Math.max(max, drill.batch.order), 0),
      processedTokens: rebuildTokens(rebuiltDrills),
      hydrated: true,
      notice: null,
      unpersistedBatches: {},
    };
    // 用当前变更校准版本：存量旧方案标待补，离线期间变更的方案作废未执行演练
    return refreshQueue(reconcileAll(merged, changes, { markLegacy: true }), changes);
  }),

  on(RollbackDrillActions.submitDrillAccepted, (state, { drill }) => {
    if (state.drills[drill.id]) {
      return state; // 幂等：同令牌已受理
    }
    return markDirty(
      {
        ...state,
        drills: { ...state.drills, [drill.id]: drill },
        orderSequence: Math.max(state.orderSequence, drill.batch.order),
        versions: state.versions[drill.changeId]
          ? state.versions
          : {
              ...state.versions,
              [drill.changeId]: {
                ...buildPlanVersion(drill.batch.planSnapshot),
                gateState: 'active',
              },
            },
        processedTokens: { ...state.processedTokens, [drill.batch.clientToken]: drill.id },
        notice: null,
      },
      drill.batch,
    );
  }),

  on(RollbackDrillActions.submitDrillConflict, (state, { reason }) => ({
    ...state,
    notice: { kind: 'conflict', message: reason },
  })),

  // 后到的并发提交：保留冲突记录，不占用排队资源，也不覆盖冲突提示
  on(RollbackDrillActions.retainConflictDrill, (state, { drill }) => {
    if (state.drills[drill.id]) {
      return state;
    }
    return markDirty(
      {
        ...state,
        drills: { ...state.drills, [drill.id]: drill },
        orderSequence: Math.max(state.orderSequence, drill.batch.order),
        processedTokens: { ...state.processedTokens, [drill.batch.clientToken]: drill.id },
      },
      drill.batch,
    );
  }),

  on(RollbackDrillActions.submitDrillRejected, (state, { changeId, reason }) => ({
    ...state,
    notice: { kind: 'rejected', message: `${changeId}：${reason}` },
  })),

  on(RollbackDrillActions.startBatch, (state, { drillId }) => {
    const drill = state.drills[drillId];
    if (!drill || drill.status !== 'queued' || drill.batch.blockedBy.length > 0) {
      return state;
    }
    const timestamp = nowIso();
    const updated: DrillRecord = {
      ...drill,
      status: 'running',
      batch: { ...drill.batch, startedAt: timestamp, blockedBy: [] },
      updatedAt: timestamp,
    };
    return markDirty({ ...state, drills: { ...state.drills, [drillId]: updated } }, updated.batch);
  }),

  on(RollbackDrillActions.completeBatch, (state, { drillId, result, note }) => {
    const drill = state.drills[drillId];
    if (!drill || drill.status !== 'running') {
      return state;
    }
    const timestamp = nowIso();
    const finishedBatch: DrillBatch = {
      ...drill.batch,
      finishedAt: timestamp,
      blockedBy: [],
      outcome: {
        result,
        note,
        at: timestamp,
      },
    };
    const finished: DrillRecord = {
      ...drill,
      status: result === 'success' ? 'succeeded' : 'failed',
      result,
      resultNote: note,
      batch: finishedBatch,
      credentialId:
        result === 'success'
          ? credentialIdOf(drill.changeId, drill.fingerprint)
          : drill.credentialId,
      updatedAt: timestamp,
    };

    let next: RollbackDrillState = {
      ...state,
      drills: { ...state.drills, [drillId]: finished },
    };

    // 成功即冻结拓扑与命令摘要并签发凭证；同版本同批次只签一张
    if (result === 'success') {
      const credentialId = credentialIdOf(drill.changeId, drill.fingerprint);
      const liveVersion = state.versions[drill.changeId];
      // 旧方案补齐凭证后，门禁由“待补”翻为“有效”
      if (liveVersion && liveVersion.gateState === 'legacy_backfill') {
        next = {
          ...next,
          versions: {
            ...next.versions,
            [drill.changeId]: { ...liveVersion, gateState: 'active' },
          },
        };
      }
      if (!state.credentials[credentialId]) {
        const snapshot = drill.batch.planSnapshot;
        const version = state.versions[drill.changeId] ?? buildPlanVersion(snapshot);
        const credential: ReleaseCredential = {
          id: credentialId,
          changeId: drill.changeId,
          fingerprint: drill.fingerprint,
          versionLabel: drill.versionLabel,
          drillId,
          batchId: drill.batch.id,
          issuedBy: drill.submittedBy,
          issuedAt: timestamp,
          status: 'issued',
          frozen: buildFrozenSnapshot(snapshot, version, timestamp),
        };
        next = { ...next, credentials: { ...next.credentials, [credentialId]: credential } };
      }
    }

    return markDirty(next, finishedBatch);
  }),

  on(RollbackDrillActions.reconcilePlanVersions, (state, { changes }) =>
    refreshQueue(reconcileAll(state, changes, { markLegacy: false }), changes),
  ),

  on(RollbackDrillActions.refreshQueue, (state, { changes }) => refreshQueue(state, changes)),

  // 创建草稿时同步登记一个 active 版本（新方案不属于待补旧方案）
  on(ChangeRequestActions.createChange, (state, { change }) =>
    state.versions[change.id]
      ? state
      : {
          ...state,
          versions: { ...state.versions, [change.id]: buildPlanVersion(change, 'active') },
        },
  ),

  on(RollbackDrillActions.recoverFromBatch, (state, { batch }) => restoreFromBatch(state, batch)),

  on(RollbackDrillActions.recoverFromBatchFailure, (state, { batchId, error }) => ({
    ...state,
    notice: { kind: 'persist_failure', message: `批次 ${batchId} 恢复失败：${error}` },
  })),

  on(RollbackDrillActions.persistFailure, (state, { error }) => ({
    ...state,
    notice: {
      kind: 'persist_failure',
      message: `${error} 可从完整演练批次恢复，重放不会新增凭证。`,
    },
  })),

  on(RollbackDrillActions.persistSuccess, (state) => ({
    ...state,
    unpersistedBatches: {},
  })),

  on(RollbackDrillActions.resetDrillData, () => ({ ...initialRollbackDrillState })),

  on(RollbackDrillActions.clearNotice, (state) => ({ ...state, notice: null })),
);
