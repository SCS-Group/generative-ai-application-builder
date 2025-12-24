import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { UsagePage } from '@/portal/pages/UsagePage';

const getVoiceUsageMock = vi.fn();
vi.mock('@/portal/api/usage', async () => {
  const actual = await vi.importActual<any>('@/portal/api/usage');
  return { ...actual, getVoiceUsage: (...args: any[]) => getVoiceUsageMock(...args) };
});

describe('UsagePage', () => {
  it('renders totals when usage is returned', async () => {
    getVoiceUsageMock.mockResolvedValueOnce({
      tenantId: 't1',
      range: { days: 7, startIso: '2025-01-01T00:00:00Z', endIso: '2025-01-08T00:00:00Z' },
      totals: {
        calls: 3,
        endedCalls: 2,
        errorCalls: 0,
        totalDurationSec: 180,
        totalDurationMinutes: 3,
        avgDurationSec: 60,
        avgTurns: 4,
        avgLatencyMs: 1200,
        lastCallAt: '2025-01-07T00:00:00Z',
        pricing: { ratePerMinuteUsd: 0.25, estimatedCostUsd: 0.75, marginPct: 0.5 }
      },
      byUseCase: [
        {
          useCaseId: 'u1',
          useCaseName: 'scheduler',
          calls: 3,
          endedCalls: 2,
          errorCalls: 0,
          totalDurationSec: 180,
          avgDurationSec: 60,
          avgTurns: 4,
          avgLatencyMs: 1200,
          pricing: { ratePerMinuteUsd: 0.25, estimatedCostUsd: 0.75, marginPct: 0.5 }
        }
      ]
    });

    render(<UsagePage />);

    await waitFor(() => expect(screen.queryByText('Loading usage…')).not.toBeInTheDocument());
    expect(screen.getByText('Calls')).toBeInTheDocument();
    const callsCard = screen.getByText('Calls').parentElement;
    expect(callsCard).not.toBeNull();
    expect(within(callsCard as HTMLElement).getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Total minutes')).toBeInTheDocument();
    expect(screen.getByText('Estimated cost')).toBeInTheDocument();
    expect(screen.getAllByText(/\/min$/).length).toBeGreaterThan(0);
  });

  it('shows an error alert when the request fails', async () => {
    getVoiceUsageMock.mockRejectedValueOnce(new Error('boom'));

    render(<UsagePage />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});


