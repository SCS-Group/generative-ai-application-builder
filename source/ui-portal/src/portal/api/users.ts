import { API } from 'aws-amplify';
import { getIdToken } from '@/portal/auth/token';

const API_NAME = 'api';

export type InviteUserRequest = {
  email: string;
  username?: string;
};

export type InviteUserResponse = {
  username: string;
  email: string;
  tenantId?: string;
  role?: string;
  groupName?: string;
};

export type PortalUser = {
  username: string;
  email: string;
  status: 'invited' | 'active' | 'disabled' | 'unknown' | string;
  userStatus?: string;
  enabled?: boolean;
  groupName?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ListPortalUsersResponse = {
  tenantId: string;
  users: PortalUser[];
};

export async function listPortalUsers(): Promise<ListPortalUsersResponse> {
  const token = await getIdToken();
  return await API.get(API_NAME, '/portal/users', {
    headers: { Authorization: token }
  });
}

export async function invitePortalUser(req: InviteUserRequest): Promise<InviteUserResponse> {
  const token = await getIdToken();
  return await API.post(API_NAME, '/portal/users', {
    headers: { Authorization: token },
    body: req
  });
}


