import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState =
  createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectAllChanges = createSelector(
  selectChangeRequestState,
  (state) => state.changes,
);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(
  selectChangeRequestState,
  (state) => state.error,
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );
