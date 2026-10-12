import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Shield, LayoutDashboard, PlusCircle, List, Bell, Scale, BarChart2, Settings, LogOut, Radio, Menu, X, UserCog, Upload } from 'lucide-react';
import NotificationBell from './NotificationBell';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navClass = ({ isActive }) =>
    `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
    }`;

  const links = (
    <>
      <NavLink to="/dashboard" className={navClass} onClick={() => setMobileOpen(false)}>
        <LayoutDashboard size={16} /> Dashboard
      </NavLink>
      <NavLink to="/new-transaction" className={navClass} onClick={() => setMobileOpen(false)}>
        <PlusCircle size={16} /> New Transaction
      </NavLink>
      <NavLink to="/bulk-import" className={navClass} onClick={() => setMobileOpen(false)}>
        <Upload size={16} /> Bulk Import
      </NavLink>
      <NavLink to="/transactions" className={navClass} onClick={() => setMobileOpen(false)}>
        <List size={16} /> Transactions
      </NavLink>
      <NavLink to="/alerts" className={navClass} onClick={() => setMobileOpen(false)}>
        <Bell size={16} /> Alerts
      </NavLink>
      <NavLink to="/disputes" className={navClass} onClick={() => setMobileOpen(false)}>
        <Scale size={16} /> Disputes
      </NavLink>
      <NavLink to="/analytics" className={navClass} onClick={() => setMobileOpen(false)}>
        <BarChart2 size={16} /> Analytics
      </NavLink>
      <NavLink to="/live-feed" className={navClass} onClick={() => setMobileOpen(false)}>
        <Radio size={16} /> Live Feed
      </NavLink>
      {user?.role === 'admin' && (
        <NavLink to="/admin" className={navClass} onClick={() => setMobileOpen(false)}>
          <Settings size={16} /> Admin
        </NavLink>
      )}
    </>
  );

  return (
    <nav className="bg-[#0a0f14] border-b border-white/10 px-4 sm:px-6 py-3 sticky top-0 z-50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-8">
          <NavLink to="/dashboard" className="flex items-center gap-2.5 shrink-0">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
              <Shield size={16} className="text-cyan-400" />
            </span>
            <span className="text-white font-semibold text-[15px] tracking-tight">FraudGuard</span>
          </NavLink>
          <div className="hidden lg:flex items-center gap-1">
            {links}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell />
          <span className="hidden sm:inline text-gray-400 text-sm">{user?.username}</span>
          <NavLink
            to="/settings"
            title="Account Settings"
            className={({ isActive }) => `hidden lg:flex items-center justify-center p-2 rounded-lg transition-colors ${
              isActive ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <UserCog size={18} />
          </NavLink>
          <button
            onClick={handleLogout}
            className="hidden lg:flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <LogOut size={16} /> Logout
          </button>
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="lg:hidden text-gray-300 hover:text-white p-2 -mr-2 transition-colors"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="lg:hidden mt-3 pb-2 flex flex-col gap-1 animate-page-in">
          {links}
          <NavLink to="/settings" className={navClass} onClick={() => setMobileOpen(false)}>
            <UserCog size={16} /> Account Settings
          </NavLink>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors mt-2"
          >
            <LogOut size={16} /> Logout
          </button>
        </div>
      )}
    </nav>
  );
}
