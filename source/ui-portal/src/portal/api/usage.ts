import { API } from 'aws-amplify';
import { getIdToken } from '@/portal/auth/token';

const API_NAME = 'api';

export type VoiceUsageTotals = {
  calls: number;
  endedCalls: number;
  errorCalls: number;
  totalDurationSec: number;
  totalDurationMinutes: number;
  avgDurationSec: number;
  avgTurns: number;
  avgLatencyMs: number;
  lastCallAt: string | null;
  metering?: {
    billableMinutes: number;
    approxInputTokens: number;
    approxOutputTokens: number;
  };
  pricing?: {
    ratePerMinuteUsd: number | null;
    estimatedCostUsd: number | null;
    marginPct: number;
  };
};

export type VoiceUsageByUseCase = {
  useCaseId: string;
  useCaseName: string;
  calls: number;
  endedCalls: number;
  errorCalls: number;
  totalDurationSec: number;
  avgDurationSec: number;
  avgTurns: number;
  avgLatencyMs: number;
  lastCallAt?: string;
  metering?: {
    billableMinutes: number;
    approxInputTokens: number;
    approxOutputTokens: number;
    modelHint: string | null;
  };
  pricing?: {
    ratePerMinuteUsd: number | null;
    estimatedCostUsd: number | null;
    marginPct: number;
  };
};

export type VoiceUsageResponse = {
  tenantId: string;
  range: { days: number; startIso: string; endIso: string };
  totals: VoiceUsageTotals;
  byUseCase: VoiceUsageByUseCase[];
};

export async function getVoiceUsage(days: number = 7): Promise<VoiceUsageResponse> {
  const token = await getIdToken();
  return await API.get(API_NAME, '/usage/voice', {
    headers: { Authorization: token },
    queryStringParameters: { days: String(days) }
  });
}


