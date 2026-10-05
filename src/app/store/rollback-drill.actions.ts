import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { ChangeRequest } from '../models/change-request.model';
import {
  DrillBatch,
  DrillRecord,
  DrillSubmissionInput,
  PlanVersion,
  ReleaseCredential,
} from '../models/rollback-drill.model';

export const RollbackDrillActions = createActionGroup({
  source: 'Rollback Drill',
  events: {
    Hydrate: props<{
      changes: ChangeRequest[];
      versions: PlanVersion[];
      drills: DrillRecord[];
      credentials: ReleaseCredential[];
    }>(),

    'Submit Drill': props<{ input: DrillSubmissionInput }>(),
    'Submit Drill Rejected': props<{ changeId: string; reason: string }>(),
    'Submit Drill Conflict': props<{
      changeId: string;
      reason: string;
      winnerId: string;
      retainedDrill: DrillRecord;
    }>(),
    /** 后到的并发提交保留冲突记录（不覆盖冲突提示） */
    'Retain Conflict Drill': props<{ drill: DrillRecord }>(),
    'Submit Drill Accepted': props<{ drill: DrillRecord }>(),

    /** 共享资源到位，开始一个排队批次 */
    'Start Batch': props<{ drillId: string }>(),
    /** 占用变化时重算所有排队批次的阻塞项 */
    'Refresh Queue': props<{ changes: ChangeRequest[] }>(),
    'Complete Batch': props<{
      drillId: string;
      result: 'success' | 'failure';
      note: string;
    }>(),

    /**
     * 方案发生保存/会签变化：未执行演练按版本指纹作废，
     * 已成功的演练及其凭证保留在旧版本上。
     */
    'Reconcile Plan Versions': props<{ changes: ChangeRequest[] }>(),

    /** 写入失败后，从完整演练批次恢复并重放，重放不新增凭证 */
    'Recover From Batch': props<{ batch: DrillBatch }>(),
    'Recover From Batch Failure': props<{ batchId: string; error: string }>(),

    'Persist Failure': props<{ error: string }>(),
    'Persist Success': emptyProps(),
    /** 演练用：清空本地演练数据，模拟写入失败后仅靠完整批次恢复 */
    'Reset Drill Data': emptyProps(),
    'Clear Notice': emptyProps(),
  },
});
