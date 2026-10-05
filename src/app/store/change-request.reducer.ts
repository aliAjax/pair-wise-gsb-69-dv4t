import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
} from '../models/change-request.model';
import {
  DrillBatch,
  DrillBatchStatus,
  DRILLABLE_STATUSES,
  computePlanDigests,
  createDrillBatch,
  createDrillCredential,
  drillQueueBlockers,
  isCredentialValid,
} from '../models/rollback-drill.model';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
};

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return APPROVAL_ORDER.find((stage) =>
    change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
  ) ?? null;
}

/**
 * 拓扑、命令或窗口任一摘要变化都会推进方案版本；
 * 未执行（排队中）的演练批次随之作废，已执行批次保留原凭证。
 */
function applyPlanVersioning(current: ChangeRequest, next: ChangeRequest): ChangeRequest {
  const before = computePlanDigests(current);
  const after = computePlanDigests(next);
  if (before.digest === after.digest) {
    return next;
  }

  const planVersion = current.planVersion + 1;
  const changedAspects = [
    before.topology !== after.topology ? '拓扑' : null,
    before.command !== after.command ? '命令' : null,
    before.window !== after.window ? '窗口' : null,
  ]
    .filter((aspect): aspect is string => aspect !== null)
    .join('、');
  const finishedAt = new Date().toISOString();
  const drillBatches = next.drillBatches.map((batch) =>
    batch.status === 'queued'
      ? {
          ...batch,
          status: 'voided' as const,
          finishedAt,
          voidReason: `${changedAspects}变化，方案版本推进至 v${planVersion}，未执行批次作废`,
        }
      : batch,
  );

  return {
    ...next,
    planVersion,
    drillBatches,
    audit: [
      createAudit(
        '方案版本推进',
        `${changedAspects}变化，版本推进至 v${planVersion}，未执行演练批次作废，已执行批次保留原凭证`,
      ),
      ...next.audit,
    ],
  };
}

const BATCH_PROGRESS: Record<DrillBatchStatus, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  voided: 2,
  conflict: 2,
};

/**
 * 从完整演练批次恢复：批次按 id 归并，推进度更深的一方生效；
 * 凭证优先保留已签发的那张，重复重放不会新增凭证。
 */
function mergeRecoveredBatch(existing: DrillBatch, recovered: DrillBatch): DrillBatch {
  const winner =
    BATCH_PROGRESS[recovered.status] >= BATCH_PROGRESS[existing.status] ? recovered : existing;
  const loser = winner === recovered ? existing : recovered;
  const credential = winner.credential ?? loser.credential;
  if (winner === existing && credential === existing.credential) {
    return existing;
  }
  return { ...winner, credential };
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes,
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    changes: [
      {
        ...change,
        planVersion: change.planVersion ?? 1,
        drillBatches: change.drillBatches ?? [],
        audit: [createAudit('创建草稿', `创建变更 ${change.id}`), ...change.audit],
      },
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change }) => ({
    ...state,
    changes: state.changes.map((item) =>
      item.id === change.id
        ? touch(
            applyPlanVersioning(item, {
              ...change,
              planVersion: item.planVersion,
              drillBatches: item.drillBatches,
              activeCredential: item.activeCredential,
              audit: [
                createAudit('保存变更方案', '更新资源、步骤或窗口信息'),
                ...change.audit,
              ],
            }),
          )
        : item,
    ),
  })),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && ['draft', 'rejected'].includes(change.status)
        ? touch({
            ...change,
            status: 'submitted',
            approvals: change.approvals.map((approval) =>
              approval.stage === 'network'
                ? { ...approval, state: 'pending' }
                : { ...approval, state: 'pending' },
            ),
            audit: [createAudit('提交审批', '方案冻结后进入网络、系统、安全、业务顺序会签'), ...change.audit],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextPendingStage(change) !== stage) {
        return change;
      }

      const approvals = change.approvals.map((approval) =>
        approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
              planVersion: change.planVersion,
            }
          : approval,
      );
      const allApproved = approvals.every((approval) =>
        approval.stage === stage ? true : approval.state === 'approved',
      );

      return touch({
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        audit: [
          createAudit('阶段会签', `${stage} 已由 ${approver} 批准（方案 v${change.planVersion}）：${comment}`),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            status: 'rejected',
            approvals: change.approvals.map((approval) =>
              approval.stage === stage
                ? {
                    ...approval,
                    state: 'rejected',
                    approver,
                    comment,
                    decidedAt: new Date().toISOString(),
                    planVersion: change.planVersion,
                  }
                : approval,
            ),
            audit: [createAudit('审批退回', `${stage} 由 ${approver} 退回：${comment}`), ...change.audit],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.startExecution, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'approved' && isCredentialValid(change)
        ? touch({
            ...change,
            status: 'executing',
            approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
            audit: [
              createAudit(
                '开始执行',
                `凭演练凭证 ${change.activeCredential?.id} 放行，审批记录已冻结`,
              ),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            steps: change.steps.map((step) =>
              step.id === stepId
                ? {
                    ...step,
                    completed: !step.completed,
                    completedAt: step.completed ? undefined : new Date().toISOString(),
                  }
                : step,
            ),
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.recordDeviation, (state, { id, deviation }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            deviations: [deviation, ...change.deviations],
            audit: [
              createAudit('记录执行偏离', `${deviation.owner}：${deviation.description}`),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'executing'
        ? touch({
            ...change,
            status: result,
            audit: [
              createAudit(result === 'completed' ? '执行完成' : '执行回滚', note),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.submitDrillBatch, (state, { id, operator, baseVersion }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || !DRILLABLE_STATUSES.includes(change.status)) {
        return change;
      }

      const batch = createDrillBatch(change, operator);
      const active = change.drillBatches.find(
        (candidate) =>
          ['queued', 'running'].includes(candidate.status) &&
          candidate.planVersion === change.planVersion,
      );

      // 两个值班员同时提交时先到生效，后到的批次保留为冲突记录
      if (active || baseVersion !== change.planVersion) {
        const conflictReason = active
          ? `值班员 ${active.operator} 的批次 ${active.id} 已先行提交，本批次保留冲突`
          : `提交基于方案 v${baseVersion}，当前已是 v${change.planVersion}，本批次保留冲突`;
        return touch({
          ...change,
          drillBatches: [...change.drillBatches, { ...batch, status: 'conflict', conflictReason }],
          audit: [
            createAudit('演练提交冲突保留', `${operator} 提交 ${batch.id}：${conflictReason}`),
            ...change.audit,
          ],
        });
      }

      return touch({
        ...change,
        drillBatches: [...change.drillBatches, batch],
        audit: [
          createAudit(
            '演练批次排队',
            `${operator} 提交批次 ${batch.id}（方案 v${batch.planVersion}），占用隔离链路，按共享资源排队`,
          ),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.startDrillBatch, (state, { id, batchId }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id) {
        return change;
      }
      const batch = change.drillBatches.find((candidate) => candidate.id === batchId);
      if (
        !batch ||
        batch.status !== 'queued' ||
        batch.planVersion !== change.planVersion ||
        drillQueueBlockers(batch, change, state.changes).length > 0
      ) {
        return change;
      }

      return touch({
        ...change,
        drillBatches: change.drillBatches.map((candidate) =>
          candidate.id === batchId
            ? { ...candidate, status: 'running' as const, startedAt: new Date().toISOString() }
            : candidate,
        ),
        audit: [
          createAudit('演练开始', `批次 ${batchId} 获得共享资源，在隔离链路上开始回滚演练`),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.completeDrillBatch, (state, { id, batchId, result, note }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id) {
        return change;
      }
      const batch = change.drillBatches.find((candidate) => candidate.id === batchId);
      if (!batch || batch.status !== 'running') {
        return change;
      }

      const finishedAt = new Date().toISOString();
      if (result === 'succeeded') {
        // 凭证按批次幂等签发：重放同一批次复用原凭证，不新增
        const credential = batch.credential ?? createDrillCredential(batch, batch.operator);
        return touch({
          ...change,
          drillBatches: change.drillBatches.map((candidate) =>
            candidate.id === batchId
              ? { ...candidate, status: 'succeeded' as const, finishedAt, note, credential }
              : candidate,
          ),
          activeCredential: credential,
          audit: [
            createAudit(
              '演练成功签发凭证',
              `批次 ${batchId} 演练成功，签发凭证 ${credential.id}，冻结拓扑与命令摘要（${credential.digest}），仅该凭证可放行执行`,
            ),
            ...change.audit,
          ],
        });
      }

      return touch({
        ...change,
        drillBatches: change.drillBatches.map((candidate) =>
          candidate.id === batchId
            ? { ...candidate, status: 'failed' as const, finishedAt, note }
            : candidate,
        ),
        audit: [createAudit('演练失败', `批次 ${batchId}：${note}`), ...change.audit],
      });
    }),
  })),
  on(ChangeRequestActions.recoverDrillBatch, (state, { id, batch }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id) {
        return change;
      }
      const existing = change.drillBatches.find((candidate) => candidate.id === batch.id);
      const merged = existing ? mergeRecoveredBatch(existing, batch) : batch;
      const activeCredential = change.activeCredential ?? merged.credential;
      if (existing && merged === existing && activeCredential === change.activeCredential) {
        return change;
      }

      return touch({
        ...change,
        drillBatches: existing
          ? change.drillBatches.map((candidate) => (candidate.id === batch.id ? merged : candidate))
          : [...change.drillBatches, merged],
        activeCredential,
        audit: [
          createAudit(
            '演练批次恢复',
            `写入失败后从完整批次 ${batch.id} 恢复，重复重放不新增凭证`,
          ),
          ...change.audit,
        ],
      });
    }),
  })),
);
