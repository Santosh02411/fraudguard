import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Shield, LayoutDashboard, PlusCircle, Bell, BarChart2, Settings, LogOut } from 'lucide-react';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navClass = ({ isActive }) =>
    `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive ? 'bg-purple-600 text-white' : 'text-gray-300 hover:text-white hover:bg-white/10'
    }`;

  return (
    <nav className="bg-[#0d1117] border-b border-white/10 px-6 py-3 flex items-center justify-between sticky top-0 z-50">
      <div className="flex items-center gap-8">
        <NavLink to="/dashboard" className="flex items-center gap-2 text-purple-400 font-bold text-xl">
          <Shield size={24} />
          FraudGuard
        </NavLink>
        <div className="flex items-center gap-1">
          <NavLink to="/dashboard" className={navClass}>
            <LayoutDashboard size={16} /> Dashboard
          </NavLink>
          <NavLink to="/new-transaction" className={navClass}>
            <PlusCircle size={16} /> New Transaction
          </NavLink>
          <NavLink to="/alerts" className={navClass}>
            <Bell size={16} /> Alerts
          </NavLink>
          <NavLink to="/analytics" className={navClass}>
            <BarChart2 size={16} /> Analytics
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin" className={navClass}>
              <Settings size={16} /> Admin
            </NavLink>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-gray-400 text-sm">{user?.username}</span>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <LogOut size={16} /> Logout
        </button>
      </div>
    </nav>
  );
}
