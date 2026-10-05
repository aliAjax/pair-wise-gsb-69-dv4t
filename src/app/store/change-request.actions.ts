import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
} from '../models/change-request.model';
import { DrillBatch } from '../models/rollback-drill.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    'Update Change': props<{ change: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Start Execution': props<{ id: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),
    'Submit Drill Batch': props<{ id: string; operator: string; baseVersion: number }>(),
    'Start Drill Batch': props<{ id: string; batchId: string }>(),
    'Complete Drill Batch': props<{
      id: string;
      batchId: string;
      result: 'succeeded' | 'failed';
      note: string;
    }>(),
    'Recover Drill Batch': props<{ id: string; batch: DrillBatch }>(),
  },
});
