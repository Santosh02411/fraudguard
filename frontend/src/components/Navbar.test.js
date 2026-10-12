import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar';

const mockLogout = jest.fn();
const mockNavigate = jest.fn();
const mockGet = jest.fn();
let mockUser = { username: 'alice', role: 'user' };

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, logout: mockLogout }),
  api: { get: (...args) => mockGet(...args) },
}));

jest.mock('../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockLogout.mockClear();
  mockNavigate.mockClear();
  mockGet.mockReset();
  mockGet.mockResolvedValue({ data: { alerts: [] } });
});

describe('Navbar', () => {
  test('shows the core nav links and the current username', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();
    await waitFor(() => expect(mockGet).toHaveBeenCalled()); // let NotificationBell's initial fetch settle

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('New Transaction')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Live Feed')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  test('hides the Admin link for a regular user', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  test('shows the Admin link for an admin user', async () => {
    mockUser = { username: 'root', role: 'admin' };
    renderNavbar();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  test('clicking Logout calls logout() and navigates to /login', async () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Logout'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});
