import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DisputesPage from './DisputesPage';

const mockGet = jest.fn();
const mockPatch = jest.fn();

let mockUser = { id: 1, username: 'test_user', role: 'user' };

jest.mock('../context/AuthContext', () => ({
  api: { get: (...args) => mockGet(...args), patch: (...args) => mockPatch(...args) },
  useAuth: () => ({ user: mockUser }),
}));

// jest.mock calls above are hoisted above these imports by babel-jest at
// compile time, so DisputesPage picks up the mocked modules regardless of
// this file's source order.

function renderPage() {
  return render(<MemoryRouter><DisputesPage /></MemoryRouter>);
}

function makeDispute(overrides = {}) {
  return {
    id: 1,
    transaction_id: 100,
    status: 'opened',
    amount_disputed: 80,
    reason: 'I did not make this purchase.',
    evidence_note: null,
    resolution_note: null,
    merchant: 'Corner Cafe',
    account_username: 'test_user',
    opened_by_username: 'test_user',
    opened_at: '2026-01-01T12:00:00Z',
    ...overrides,
  };
}

function makeSummary(overrides = {}) {
  return {
    total_disputes: 3,
    by_status: { opened: 1, evidence_submitted: 0, won: 1, lost: 1 },
    total_amount_disputed: 220,
    amount_won: 100,
    amount_lost: 40,
    amount_pending: 80,
    win_rate: 50,
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockUser = { id: 1, username: 'test_user', role: 'user' };
});

describe('DisputesPage — regular user', () => {
  test('shows a loading state, then the fetched disputes, without a financial summary', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });

    renderPage();
    expect(screen.getByText(/Loading disputes/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('I did not make this purchase.')).toBeInTheDocument());

    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('Opened')).toBeInTheDocument();
    // Only the list call — no financial-summary request for a non-admin.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/disputes', { params: {} });
    expect(screen.queryByText('Total Disputes')).not.toBeInTheDocument();
  });

  test('shows an empty state when there are no disputes', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No disputes match these filters/i)).toBeInTheDocument());
  });

  test('shows an error state with a working retry', async () => {
    mockGet.mockRejectedValueOnce({ response: { data: { error: 'Failed to load' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Failed to load')).toBeInTheDocument());

    mockGet.mockResolvedValueOnce({ data: { disputes: [makeDispute()] } });
    fireEvent.click(screen.getByText(/Retry/i));
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
  });

  test('does not offer an Update action, since transitions are admin-only', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
    expect(screen.queryByText('Update')).not.toBeInTheDocument();
  });

  test('filtering by status re-fetches with the status param', async () => {
    mockGet.mockResolvedValue({ data: { disputes: [makeDispute()] } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Filters/i));
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'won' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/disputes', { params: { status: 'won' } }));
  });
});

describe('DisputesPage — admin', () => {
  beforeEach(() => {
    mockUser = { id: 9, username: 'admin', role: 'admin' };
  });

  test('also loads and renders the financial summary', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [makeDispute({ account_username: 'someone_else' })] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());

    expect(screen.getByText('Total Disputes')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument(); // amount_won
    expect(screen.getByText('50%')).toBeInTheDocument(); // win_rate
    expect(screen.getByText(/on someone_else's account/)).toBeInTheDocument();
  });

  test('shows an Update action for an open case, and can advance it to won with a note', async () => {
    const dispute = makeDispute();
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [dispute] } });
    });
    mockPatch.mockResolvedValue({ data: { dispute: { ...dispute, status: 'won', resolution_note: 'Evidence was sufficient.' } } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));
    // opened -> evidence_submitted / won / lost should all be offered
    expect(screen.getByText('Evidence Submitted')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Evidence submitted, outcome details/i), {
      target: { value: 'Evidence was sufficient.' },
    });
    fireEvent.click(screen.getByText('Won'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/disputes/1', { status: 'won', note: 'Evidence was sufficient.' }));
    await waitFor(() => expect(screen.getByText(/Evidence was sufficient\./)).toBeInTheDocument());
  });

  test('offers no further action once a dispute is resolved', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [makeDispute({ status: 'won', resolution_note: 'Reversed in our favor.' })] } });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Corner Cafe')).toBeInTheDocument());
    expect(screen.queryByText('Update')).not.toBeInTheDocument();
  });

  test('shows a transition error inline without discarding the form', async () => {
    const dispute = makeDispute();
    mockGet.mockImplementation((url) => {
      if (url === '/disputes/financial-summary') return Promise.resolve({ data: makeSummary() });
      return Promise.resolve({ data: { disputes: [dispute] } });
    });
    mockPatch.mockRejectedValue({ response: { data: { error: 'Not a legal transition' } } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Update'));
    fireEvent.click(screen.getByText('Won'));

    await waitFor(() => expect(screen.getByText('Not a legal transition')).toBeInTheDocument());
    // form stays open so the admin can retry
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});
