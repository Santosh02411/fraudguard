import React, { useState, useEffect } from 'react';
import { api } from '../context/AuthContext';
import { useAuth } from '../context/AuthContext';
import { Shield, Users, Activity, AlertTriangle, TrendingUp } from 'lucide-react';

function StatCard({ title, value, color }) {
  return (
    <div className="bg-[#161b22] border border-white/10 rounded-xl p-6">
      <p className="text-gray-400 text-sm mb-1">{title}</p>
      <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
    </div>
  );
}

export default function AdminPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const loadData = () => {
    Promise.all([
      api.get('/admin/stats'),
      api.get('/admin/users'),
    ]).then(([sRes, uRes]) => {
      setStats(sRes.data);
      setUsers(uRes.data.users);
    }).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const changeRole = async (userId, newRole) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, { role: newRole });
      setMsg(`Role updated to ${newRole}`);
      loadData();
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to update role');
      setTimeout(() => setMsg(''), 3000);
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading admin panel...</div>;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Admin Panel</h1>
        <p className="text-gray-400 mt-1">System administration and monitoring</p>
      </div>

      {msg && (
        <div className="mb-4 bg-purple-500/10 border border-purple-500/30 text-purple-300 rounded-lg px-4 py-3 text-sm">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="Total Users" value={stats?.total_users ?? 0} />
        <StatCard title="System Transactions" value={stats?.total_transactions ?? 0} />
        <StatCard title="Active Alerts" value={stats?.active_alerts ?? 0} color="text-yellow-400" />
        <StatCard title="System Fraud Rate" value={`${stats?.system_fraud_rate ?? 0}%`} color={stats?.system_fraud_rate > 15 ? 'text-red-400' : 'text-orange-400'} />
      </div>

      <div className="bg-[#161b22] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">User Management</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-gray-400 text-sm">
                <th className="text-left px-6 py-3">Username</th>
                <th className="text-left px-6 py-3">Email</th>
                <th className="text-left px-6 py-3">Role</th>
                <th className="text-left px-6 py-3">Total Transactions</th>
                <th className="text-left px-6 py-3">Fraud Rate</th>
                <th className="text-left px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-6 py-4 text-white font-medium">{u.username}</td>
                  <td className="px-6 py-4 text-gray-300">{u.email}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                      u.role === 'admin' ? 'bg-purple-600 text-white' : 'bg-white/10 text-gray-300'
                    }`}>{u.role}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-300">{u.total_transactions}</td>
                  <td className="px-6 py-4">
                    <span className={u.fraud_rate > 0 ? 'text-orange-400' : 'text-green-400'}>
                      {u.fraud_rate}%
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {u.id === user?.id ? (
                      <span className="text-gray-500 text-sm">You</span>
                    ) : u.role === 'user' ? (
                      <button
                        onClick={() => changeRole(u.id, 'admin')}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm transition-colors"
                      >
                        Promote
                      </button>
                    ) : (
                      <button
                        onClick={() => changeRole(u.id, 'user')}
                        className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-1.5 rounded text-sm transition-colors"
                      >
                        Demote
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
