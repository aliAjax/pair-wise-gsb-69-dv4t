import {
  ApprovalRecord,
  ChangeRequest,
  ChangeResource,
  ChangeWindow,
  PHASE_LABELS,
} from './change-request.model';

/**
 * 回滚演练领域模型。
 *
 * 一条变更方案包含回滚步骤、资源依赖、演练批次和会签记录，这些内容必须绑定到
 * 同一个「方案版本」上：演练按共享资源排队，成功后冻结拓扑与命令摘要并签发凭证，
 * 只有与当前方案版本指纹一致的凭证才能放行正式执行。
 */

export type DrillStatus =
  | 'queued' // 已提交，等待共享资源
  | 'running' // 资源到位，演练进行中
  | 'succeeded' // 演练成功，已签发凭证
  | 'failed' // 演练失败
  | 'invalidated' // 方案版本变更，未执行的演练作废
  | 'conflict_retained'; // 后到的并发提交，保留冲突但不生效

export type PlanGateState =
  | 'active' // 方案版本有效
  | 'legacy_backfill'; // 旧方案，凭证待补，禁止开始执行

export interface PlanVersion {
  changeId: string;
  /** 当前方案版本指纹（拓扑 + 回滚命令 + 窗口 + 会签的内容哈希） */
  fingerprint: string;
  versionLabel: string;
  topologyDigest: string;
  commandDigest: string;
  windowDigest: string;
  approvalDigest: string;
  gateState: PlanGateState;
  updatedAt: string;
}

/** 演练成功时冻结下来的方案摘要，凭证据此放行 */
export interface FrozenSnapshot {
  fingerprint: string;
  versionLabel: string;
  topologyDigest: string;
  commandDigest: string;
  windowDigest: string;
  approvalDigest: string;
  /** 冻结时刻的拓扑摘要（资源 ID 与依赖的可读列表） */
  topologySummary: string[];
  /** 冻结时刻的回滚命令摘要（步骤 → 责任人 → 命令） */
  commandSummary: DrillCommandSummary[];
  windowLabel: string;
  approvals: ApprovalRecord[];
  frozenAt: string;
}

export interface DrillCommandSummary {
  stepId: string;
  title: string;
  owner: string;
  command: string;
}

/** 排队阻塞原因：与正式变更或先到演练争抢同一共享资源 */
export interface QueueBlocker {
  kind: 'formal_change' | 'prior_drill';
  holderId: string;
  /** 阻塞来源所属变更，用于跳转 */
  changeId: string;
  holderLabel: string;
  resourceIds: string[];
}

/**
 * 演练批次。批次内保存提交时刻完整方案快照：写入失败后，
 * 可以仅凭批次记录重建整批演练（从完整演练批次恢复）。
 */
export interface DrillBatch {
  id: string;
  clientToken: string;
  order: number;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 批次结局：写入失败后可凭完整批次重建演练状态与凭证 */
  outcome?: {
    result: 'success' | 'failure';
    note: string;
    at: string;
  };
  /** 提交时排队所依据的阻塞项 */
  blockedBy: QueueBlocker[];
  /** 完整方案快照，恢复时不依赖当前变更是否已被改动 */
  planSnapshot: ChangeRequest;
  /** 恢复重放标记：同一批次被重放时置位，且不新增凭证 */
  replayed: boolean;
}

export interface DrillRecord {
  id: string;
  changeId: string;
  /** 提交时绑定的方案版本指纹 */
  fingerprint: string;
  versionLabel: string;
  submittedBy: string;
  status: DrillStatus;
  batch: DrillBatch;
  result?: 'success' | 'failure';
  resultNote?: string;
  /** 作废或冲突保留时的说明 */
  invalidReason?: string;
  /** 成功后关联的凭证 ID */
  credentialId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CredentialStatus = 'issued' | 'revoked';

export interface ReleaseCredential {
  id: string;
  changeId: string;
  /** 凭证绑定的方案版本指纹；只有与当前版本一致才放行 */
  fingerprint: string;
  versionLabel: string;
  drillId: string;
  batchId: string;
  issuedBy: string;
  issuedAt: string;
  status: CredentialStatus;
  frozen: FrozenSnapshot;
}

export interface DrillSubmissionInput {
  change: ChangeRequest;
  submittedBy: string;
  clientToken: string;
}

export const DRILL_STATUS_LABELS: Record<DrillStatus, string> = {
  queued: '排队等待资源',
  running: '演练进行中',
  succeeded: '演练成功',
  failed: '演练失败',
  invalidated: '已作废',
  conflict_retained: '冲突保留',
};

export const GATE_STATE_LABELS: Record<PlanGateState, string> = {
  active: '版本有效',
  legacy_backfill: '凭证待补',
};

const ROLLBACK_PHASE: ChangeRequest['steps'][number]['phase'] = 'rollback';

/** 稳定字符串哈希（djb2 变种），输出 16 位十六进制 */
export function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  const high = hash.toString(16).padStart(8, '0');
  let second = 19349663;
  for (let index = 0; index < input.length; index += 1) {
    second = Math.imul(second ^ input.charCodeAt(index), 16777619) >>> 0;
  }
  return `${high}${second.toString(16).padStart(8, '0')}`;
}

function canonicalResources(resources: ChangeResource[]): unknown[] {
  return resources
    .map((resource) => ({
      id: resource.id,
      type: resource.type,
      critical: resource.critical,
      dependencies: [...resource.dependencies].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalRollbackSteps(change: ChangeRequest): unknown[] {
  return change.steps
    .filter((step) => step.phase === ROLLBACK_PHASE)
    .map((step) => ({
      id: step.id,
      title: step.title,
      owner: step.owner,
      command: step.command,
      durationMinutes: step.durationMinutes,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalWindow(window: ChangeWindow): unknown {
  return {
    start: window.start,
    end: window.end,
    observationWindowMinutes: window.observationWindowMinutes,
    blackoutProtected: window.blackoutProtected,
  };
}

function canonicalApprovals(approvals: ApprovalRecord[]): unknown[] {
  return approvals
    .map((approval) => ({
      stage: approval.stage,
      state: approval.state,
      approver: approval.approver ?? '',
      comment: approval.comment ?? '',
    }))
    .sort((left, right) => left.stage.localeCompare(right.stage));
}

export function computeTopologyDigest(change: ChangeRequest): string {
  return stableHash(JSON.stringify(canonicalResources(change.resources)));
}

export function computeCommandDigest(change: ChangeRequest): string {
  return stableHash(JSON.stringify(canonicalRollbackSteps(change)));
}

export function computeWindowDigest(change: ChangeRequest): string {
  return stableHash(JSON.stringify(canonicalWindow(change.window)));
}

export function computeApprovalDigest(change: ChangeRequest): string {
  return stableHash(JSON.stringify(canonicalApprovals(change.approvals)));
}

/**
 * 方案版本内容指纹：拓扑、回滚命令、窗口任一变化都会改变。
 * 会签通过 approvalDigest 绑定并冻结在版本/凭证中，但签署推进（pending→approved）
 * 不改变内容指纹，不会把进行中的演练作废。
 */
export function computeFingerprint(change: ChangeRequest): string {
  const payload = {
    changeId: change.id,
    resources: canonicalResources(change.resources),
    rollbackSteps: canonicalRollbackSteps(change),
    window: canonicalWindow(change.window),
  };
  return stableHash(JSON.stringify(payload));
}

export function buildPlanVersion(
  change: ChangeRequest,
  gateState: PlanGateState = 'active',
): PlanVersion {
  const fingerprint = computeFingerprint(change);
  return {
    changeId: change.id,
    fingerprint,
    versionLabel: `v-${fingerprint.slice(0, 8)}`,
    topologyDigest: computeTopologyDigest(change),
    commandDigest: computeCommandDigest(change),
    windowDigest: computeWindowDigest(change),
    approvalDigest: computeApprovalDigest(change),
    gateState,
    updatedAt: new Date().toISOString(),
  };
}

export function rollbackStepsOf(change: ChangeRequest): ChangeRequest['steps'] {
  return change.steps.filter((step) => step.phase === ROLLBACK_PHASE);
}

export function buildTopologySummary(change: ChangeRequest): string[] {
  return [...change.resources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((resource) => {
      const deps = resource.dependencies.length
        ? resource.dependencies.slice().sort().join('、')
        : '无依赖';
      return `${resource.id}（${resource.name}）→ ${deps}`;
    });
}

export function buildCommandSummary(change: ChangeRequest): DrillCommandSummary[] {
  return rollbackStepsOf(change).map((step) => ({
    stepId: step.id,
    title: step.title,
    owner: step.owner,
    command: step.command,
  }));
}

export function buildFrozenSnapshot(
  change: ChangeRequest,
  version: PlanVersion,
  frozenAt = new Date().toISOString(),
): FrozenSnapshot {
  return {
    fingerprint: version.fingerprint,
    versionLabel: version.versionLabel,
    topologyDigest: version.topologyDigest,
    commandDigest: version.commandDigest,
    windowDigest: version.windowDigest,
    approvalDigest: version.approvalDigest,
    topologySummary: buildTopologySummary(change),
    commandSummary: buildCommandSummary(change),
    windowLabel: `${change.window.start} 至 ${change.window.end}`,
    approvals: change.approvals.map((approval) => ({ ...approval })),
    frozenAt,
  };
}

export type SubmissionCheck = { ok: true } | { ok: false; reason: string };

/** 演练前置条件：方案非草稿/退回，且回滚步骤、责任人、命令齐备 */
export function checkSubmissionPrerequisites(change: ChangeRequest): SubmissionCheck {
  if (['draft', 'rejected'].includes(change.status)) {
    return { ok: false, reason: '草稿或已退回方案不能安排回滚演练。' };
  }
  const steps = rollbackStepsOf(change);
  if (steps.length === 0) {
    return { ok: false, reason: '方案没有回滚步骤，无法演练。' };
  }
  const incomplete = steps.find((step) => !step.command.trim() || !step.owner.trim());
  if (incomplete) {
    return { ok: false, reason: `回滚步骤“${incomplete.title || '未命名'}”缺少命令或责任人。` };
  }
  if (change.resources.length === 0) {
    return { ok: false, reason: '方案未声明任何资源，无法识别隔离链路。' };
  }
  return { ok: true };
}

function sharedResourceIds(left: ChangeRequest, right: ChangeRequest): string[] {
  return left.resources
    .filter((resource) => right.resources.some((candidate) => candidate.id === resource.id))
    .map((resource) => resource.id)
    .sort();
}

function windowsOverlap(left: ChangeWindow, right: ChangeWindow): boolean {
  return new Date(left.start) < new Date(right.end) && new Date(right.start) < new Date(left.end);
}

/** 正式变更持有共享资源的状态（与演练抢同一批资源） */
const FORMAL_HOLDING_STATUSES: ChangeRequest['status'][] = ['submitted', 'approved', 'executing'];

/**
 * 计算一个演练批次当前被谁阻塞：
 * - 时间窗重叠且共享资源的正式变更；
 * - 同一资源上先提交、仍在排队或进行中的演练。
 */
export function findQueueBlockers(
  planSnapshot: ChangeRequest,
  allChanges: ChangeRequest[],
  drills: DrillRecord[],
  options: { selfId?: string; formalHolderId?: string } = {},
): QueueBlocker[] {
  const blockers: QueueBlocker[] = [];

  allChanges
    .filter(
      (candidate) =>
        candidate.id !== planSnapshot.id &&
        candidate.id !== options.formalHolderId &&
        FORMAL_HOLDING_STATUSES.includes(candidate.status) &&
        windowsOverlap(planSnapshot.window, candidate.window),
    )
    .forEach((candidate) => {
      const shared = sharedResourceIds(planSnapshot, candidate);
      if (shared.length > 0) {
        blockers.push({
          kind: 'formal_change',
          holderId: candidate.id,
          changeId: candidate.id,
          holderLabel: `${candidate.id} ${candidate.title}`,
          resourceIds: shared,
        });
      }
    });

  drills
    .filter(
      (drill) =>
        drill.id !== options.selfId &&
        drill.changeId !== planSnapshot.id &&
        (drill.status === 'queued' || drill.status === 'running') &&
        windowsOverlap(planSnapshot.window, drill.batch.planSnapshot.window),
    )
    .forEach((drill) => {
      const shared = sharedResourceIds(planSnapshot, drill.batch.planSnapshot);
      if (shared.length > 0) {
        blockers.push({
          kind: 'prior_drill',
          holderId: drill.id,
          changeId: drill.changeId,
          holderLabel: `演练批次 ${drill.batch.id}（${drill.changeId}）`,
          resourceIds: shared,
        });
      }
    });

  return blockers.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'formal_change' ? -1 : 1;
    }
    return left.holderId.localeCompare(right.holderId);
  });
}

/** 同一方案同一版本上是否已有生效中的演练（排队/进行中/成功） */
export function findActiveDrillForVersion(
  drills: DrillRecord[],
  changeId: string,
  fingerprint: string,
): DrillRecord | undefined {
  return drills.find(
    (drill) =>
      drill.changeId === changeId &&
      drill.fingerprint === fingerprint &&
      ['queued', 'running', 'succeeded'].includes(drill.status),
  );
}

/** 先到生效：同一版本已有生效演练时，后到的提交只能保留冲突 */
export function findConflictingSubmission(
  drills: DrillRecord[],
  changeId: string,
  fingerprint: string,
  clientToken: string,
): DrillRecord | undefined {
  return drills.find(
    (drill) =>
      drill.changeId === changeId &&
      drill.fingerprint === fingerprint &&
      drill.batch.clientToken !== clientToken &&
      ['queued', 'running', 'succeeded', 'conflict_retained'].includes(drill.status),
  );
}

/** 凭证是否与当前方案版本匹配（旧版本凭证保留但不放行） */
export function isCredentialCurrent(
  credential: ReleaseCredential,
  version: PlanVersion | undefined,
): boolean {
  return (
    credential.status === 'issued' &&
    !!version &&
    version.gateState === 'active' &&
    credential.fingerprint === version.fingerprint
  );
}

/**
 * 执行门禁：只有当前版本的有效凭证能放行执行。
 * 旧方案凭证待补、凭证缺失、凭证属于旧版本，都会阻断开始执行。
 */
export function evaluateExecutionGate(
  change: ChangeRequest,
  version: PlanVersion | undefined,
  credential: ReleaseCredential | undefined,
): { allowed: boolean; reason: string } {
  if (['draft', 'rejected'].includes(change.status)) {
    return { allowed: false, reason: '方案尚未通过会签流程。' };
  }
  if (!version) {
    return { allowed: false, reason: '方案版本尚未登记，不能开始执行。' };
  }
  if (version.gateState === 'legacy_backfill') {
    return { allowed: false, reason: '旧方案没有回滚演练凭证，已列入待补，补齐前不能开始执行。' };
  }
  if (!credential) {
    return { allowed: false, reason: '缺少回滚演练凭证，不能开始执行。' };
  }
  if (credential.status === 'revoked') {
    return { allowed: false, reason: '回滚演练凭证已吊销。' };
  }
  if (credential.fingerprint !== version.fingerprint) {
    return {
      allowed: false,
      reason: `凭证属于旧版本 ${credential.versionLabel}，当前为 ${version.versionLabel}，请重新演练。`,
    };
  }
  return { allowed: true, reason: `凭证 ${credential.id} 与当前版本一致，允许放行。` };
}

export function phaseLabel(phase: ChangeRequest['steps'][number]['phase']): string {
  return PHASE_LABELS[phase];
}
