import { API } from 'aws-amplify';
import { getIdToken } from '@/portal/auth/token';

const API_NAME = 'api';

export async function getUseCaseSupervisors(useCaseId: string): Promise<{ usernames: string[] }> {
  const token = await getIdToken();
  return await API.get(API_NAME, `/portal/use-cases/${encodeURIComponent(useCaseId)}/supervisors`, {
    headers: { Authorization: token }
  });
}

export async function setUseCaseSupervisors(useCaseId: string, usernames: string[]): Promise<{ usernames: string[] }> {
  const token = await getIdToken();
  return await API.put(API_NAME, `/portal/use-cases/${encodeURIComponent(useCaseId)}/supervisors`, {
    headers: { Authorization: token },
    body: { usernames }
  });
}

export async function listMySupervisedUseCases(): Promise<{ useCaseIds: string[] }> {
  const token = await getIdToken();
  return await API.get(API_NAME, '/portal/my/supervised-use-cases', { headers: { Authorization: token } });
}


