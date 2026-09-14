import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar';

const mockLogout = jest.fn();
const mockNavigate = jest.fn();
let mockUser = { username: 'alice', role: 'user' };

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, logout: mockLogout }),
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
});

describe('Navbar', () => {
  test('shows the core nav links and the current username', () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('New Transaction')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Live Feed')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  test('hides the Admin link for a regular user', () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  test('shows the Admin link for an admin user', () => {
    mockUser = { username: 'root', role: 'admin' };
    renderNavbar();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  test('clicking Logout calls logout() and navigates to /login', () => {
    mockUser = { username: 'alice', role: 'user' };
    renderNavbar();

    fireEvent.click(screen.getByText('Logout'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});
