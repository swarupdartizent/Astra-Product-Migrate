import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import { queryKeys } from './queries';
import type { Assignment, GrantIn, InviteIn, SetActiveIn, User } from './types';

export const accessKeys = {
  all: ['access'] as const,
  users: (q: string) => ['access', 'users', q] as const,
};

export function useUsers(q: string) {
  return useQuery({
    queryKey: accessKeys.users(q),
    queryFn: ({ signal }) => api.get<User[]>(withQuery('/users', { q: q.trim() }), { signal }),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateAccess() {
  const qc = useQueryClient();
  // A grant or revoke may change the signed-in user's own permissions too.
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: accessKeys.all }),
      qc.invalidateQueries({ queryKey: queryKeys.me }),
    ]);
}

export function useInviteUser() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: InviteIn) => api.post<User>('/users', body),
    onSuccess: invalidate,
  });
}

export function useSetUserActive(userId: string) {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: SetActiveIn) =>
      api.put<User>(`/users/${encodeURIComponent(userId)}/active`, body),
    onSuccess: invalidate,
  });
}

export function useGrantRole() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: GrantIn) => api.post<Assignment>('/role-assignments', body),
    onSuccess: invalidate,
  });
}

export function useRevokeRole() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      api.delete<undefined>(`/role-assignments/${encodeURIComponent(assignmentId)}`),
    onSuccess: invalidate,
  });
}
