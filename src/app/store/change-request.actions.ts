import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { ApprovalStage, ChangeRequest, DeviationRecord } from '../models/change-request.model';

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
    'Approve Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
    }>(),
    'Reject Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
    }>(),
    /** 仅表达开始执行意图，是否放行由回滚演练凭证门禁决定 */
    'Start Execution': props<{ id: string }>(),
    /** 凭证校验通过后真正放行执行 */
    'Execution Released': props<{ id: string; credentialId: string }>(),
    'Execution Blocked': props<{ id: string; reason: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{
      id: string;
      result: 'completed' | 'rolled_back';
      note: string;
    }>(),
  },
});
