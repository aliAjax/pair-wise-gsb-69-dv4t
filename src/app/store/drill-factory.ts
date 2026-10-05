import { ChangeRequest } from '../models/change-request.model';
import {
  buildPlanVersion,
  DrillBatch,
  DrillRecord,
  PlanVersion,
} from '../models/rollback-drill.model';

/**
 * 演练与批次的身份由「变更 ID + clientToken + 排队序号」确定性生成，
 * 保证写入失败后从完整批次恢复、重复重放时拿到同一身份，不会新增凭证。
 */
export function drillIdOf(changeId: string, clientToken: string): string {
  return `DRL-${changeId}-${clientToken
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-10)
    .padStart(10, '0')}`;
}

export function batchIdOf(clientToken: string, order: number): string {
  return `BAT-${String(order).padStart(3, '0')}-${clientToken
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-6)
    .padStart(6, '0')}`;
}

export function credentialIdOf(changeId: string, fingerprint: string): string {
  return `CRE-${changeId}-${fingerprint.slice(0, 12)}`;
}

export function buildDrillSubmission(args: {
  change: ChangeRequest;
  submittedBy: string;
  clientToken: string;
  order: number;
  status: DrillRecord['status'];
  blockedBy: DrillBatch['blockedBy'];
  replayed: boolean;
  timestamp: string;
  version?: PlanVersion;
  invalidReason?: string;
}): DrillRecord {
  const {
    change,
    submittedBy,
    clientToken,
    order,
    status,
    blockedBy,
    replayed,
    timestamp,
    invalidReason,
  } = args;
  const version = args.version ?? buildPlanVersion(change);
  const running = status === 'running';
  const outcome = batchOutcome(status, timestamp);

  const batch: DrillBatch = {
    id: batchIdOf(clientToken, order),
    clientToken,
    order,
    requestedAt: timestamp,
    startedAt: running
      ? timestamp
      : status === 'succeeded' || status === 'failed'
        ? timestamp
        : undefined,
    finishedAt: outcome?.at,
    outcome,
    blockedBy,
    planSnapshot: structuredClone(change),
    replayed,
  };

  return {
    id: drillIdOf(change.id, clientToken),
    changeId: change.id,
    fingerprint: version.fingerprint,
    versionLabel: version.versionLabel,
    submittedBy,
    status,
    batch,
    result: outcome?.result,
    resultNote: outcome?.note,
    invalidReason,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function batchOutcome(status: DrillRecord['status'], timestamp: string): DrillBatch['outcome'] {
  if (status === 'succeeded') {
    return { result: 'success', note: '演练成功，拓扑与命令摘要已冻结。', at: timestamp };
  }
  if (status === 'failed') {
    return { result: 'failure', note: '演练未通过。', at: timestamp };
  }
  return undefined;
}
