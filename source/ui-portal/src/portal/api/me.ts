import { API } from 'aws-amplify';
import { getIdToken } from '@/portal/auth/token';

const API_NAME = 'api';

export type PortalMe = {
  userId: string | null;
  email: string | null;
  tenantId: string | null;
  groups: string[];
};

export async function getMe(): Promise<PortalMe> {
  const token = await getIdToken();
  return await API.get(API_NAME, '/portal/me', {
    headers: { Authorization: token }
  });
}


