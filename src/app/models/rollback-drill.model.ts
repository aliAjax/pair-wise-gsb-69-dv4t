import type { ChangeRequest } from './change-request.model';

export type DrillBatchStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'voided'
  | 'conflict';

/**
 * 方案版本摘要：拓扑（资源与依赖）、命令（执行/回滚步骤）、窗口三者共同决定版本。
 * 任一变化都会推进方案版本，并使未执行的演练批次作废。
 */
export interface PlanDigests {
  topology: string;
  command: string;
  window: string;
  digest: string;
}

/**
 * 演练成功后签发的放行凭证，冻结签发时的拓扑与命令摘要。
 * 只有凭证摘要与当前方案版本一致时才允许开始执行。
 */
export interface DrillCredential {
  id: string;
  batchId: string;
  planVersion: number;
  topologyDigest: string;
  commandDigest: string;
  windowDigest: string;
  digest: string;
  issuedAt: string;
  issuedBy: string;
}

export interface DrillBatch {
  id: string;
  sequence: number;
  planVersion: number;
  topologyDigest: string;
  commandDigest: string;
  windowDigest: string;
  planDigest: string;
  status: DrillBatchStatus;
  operator: string;
  resourceIds: string[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  voidReason?: string;
  conflictReason?: string;
  credential?: DrillCredential;
}

export interface DrillBlocker {
  kind: 'formal' | 'drill' | 'queue';
  sourceId: string;
  detail: string;
}

export const DRILL_STATUS_LABELS: Record<DrillBatchStatus, string> = {
  queued: '排队中',
  running: '演练中',
  succeeded: '已成功',
  failed: '已失败',
  voided: '已作废',
  conflict: '冲突保留',
};

export const DRILLABLE_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computePlanDigests(
  change: Pick<ChangeRequest, 'resources' | 'steps' | 'window'>,
): PlanDigests {
  const topology = fnv1a(
    JSON.stringify(
      [...change.resources]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((resource) => ({
          id: resource.id,
          type: resource.type,
          critical: resource.critical,
          dependencies: [...resource.dependencies].sort(),
        })),
    ),
  );
  const command = fnv1a(
    JSON.stringify(
      [...change.steps]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((step) => ({
          phase: step.phase,
          title: step.title.trim(),
          command: step.command.trim(),
        })),
    ),
  );
  const window = fnv1a(
    `${change.window.start}|${change.window.end}|${change.window.observationWindowMinutes}`,
  );
  return { topology, command, window, digest: fnv1a(`${topology}${command}${window}`) };
}

export function createDrillBatch(change: ChangeRequest, operator: string): DrillBatch {
  const digests = computePlanDigests(change);
  const sequence = change.drillBatches.reduce((max, batch) => Math.max(max, batch.sequence), 0) + 1;
  return {
    id: `DRILL-${change.id.replace(/^CHG-/, '')}-${sequence}`,
    sequence,
    planVersion: change.planVersion,
    topologyDigest: digests.topology,
    commandDigest: digests.command,
    windowDigest: digests.window,
    planDigest: digests.digest,
    status: 'queued',
    operator,
    resourceIds: change.resources.map((resource) => resource.id),
    queuedAt: new Date().toISOString(),
  };
}

/**
 * 凭证 id 由批次 id 派生，同一批次重放只会得到同一张凭证，不会新增。
 */
export function createDrillCredential(batch: DrillBatch, issuedBy: string): DrillCredential {
  return {
    id: `CRD-${batch.id}`,
    batchId: batch.id,
    planVersion: batch.planVersion,
    topologyDigest: batch.topologyDigest,
    commandDigest: batch.commandDigest,
    windowDigest: batch.windowDigest,
    digest: batch.planDigest,
    issuedAt: new Date().toISOString(),
    issuedBy,
  };
}

export function isCredentialValid(change: ChangeRequest): boolean {
  return (
    !!change.activeCredential &&
    change.activeCredential.digest === computePlanDigests(change).digest
  );
}

/**
 * 旧方案没有凭证返回 missing；方案变更后凭证摘要不再匹配返回 stale。
 */
export function credentialPendingReason(change: ChangeRequest): 'missing' | 'stale' | null {
  if (!change.activeCredential) {
    return 'missing';
  }
  return isCredentialValid(change) ? null : 'stale';
}

function sharesResources(left: string[], right: string[]): boolean {
  return left.some((id) => right.includes(id));
}

/**
 * 演练与正式变更抢同一批资源：正式变更执行中（或已批准且窗口覆盖当前时间）、
 * 其他批次演练中、以及更早排队且共享资源的批次，都会阻塞当前批次开始。
 */
export function drillQueueBlockers(
  batch: DrillBatch,
  change: ChangeRequest,
  allChanges: ChangeRequest[],
): DrillBlocker[] {
  const blockers: DrillBlocker[] = [];
  const now = Date.now();

  if (change.status === 'executing') {
    blockers.push({
      kind: 'formal',
      sourceId: change.id,
      detail: `本变更 ${change.id} 正在执行，隔离链路被占用`,
    });
  }

  allChanges
    .filter((candidate) => candidate.id !== change.id)
    .filter((candidate) =>
      sharesResources(
        batch.resourceIds,
        candidate.resources.map((resource) => resource.id),
      ),
    )
    .forEach((candidate) => {
      if (candidate.status === 'executing') {
        blockers.push({
          kind: 'formal',
          sourceId: candidate.id,
          detail: `正式变更 ${candidate.id} 正在执行，占用共享资源`,
        });
      }
      if (candidate.status === 'approved') {
        const start = new Date(candidate.window.start).getTime();
        const end = new Date(candidate.window.end).getTime();
        if (start <= now && now <= end) {
          blockers.push({
            kind: 'formal',
            sourceId: candidate.id,
            detail: `正式变更 ${candidate.id} 已批准且窗口进行中，共享资源被占用`,
          });
        }
      }
    });

  allChanges.forEach((candidate) => {
    candidate.drillBatches
      .filter((other) => other.id !== batch.id)
      .filter((other) => sharesResources(batch.resourceIds, other.resourceIds))
      .forEach((other) => {
        if (other.status === 'running') {
          blockers.push({
            kind: 'drill',
            sourceId: other.id,
            detail: `批次 ${other.id}（${candidate.id}）演练中，占用隔离链路`,
          });
        }
        if (other.status === 'queued' && other.queuedAt < batch.queuedAt) {
          blockers.push({
            kind: 'queue',
            sourceId: other.id,
            detail: `批次 ${other.id}（${candidate.id}）排队更早，按共享资源顺序等待`,
          });
        }
      });
  });

  return blockers;
}
