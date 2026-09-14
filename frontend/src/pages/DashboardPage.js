import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../context/AuthContext';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { Link } from 'react-router-dom';
import { DollarSign, AlertTriangle, Activity, TrendingUp, CheckCircle, XCircle, Wifi, WifiOff } from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';

function StatCard({ title, value, icon: Icon, color }) {
  return (
    <div className="bg-[#161b22] border border-white/10 rounded-xl p-6">
      <p className="text-gray-400 text-sm mb-1">{title}</p>
      <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
    </div>
  );
}

function RiskBadge({ level }) {
  const styles = {
    high: 'bg-red-500/20 text-red-400 border border-red-500/30',
    medium: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    low: 'bg-green-500/20 text-green-400 border border-green-500/30',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${styles[level] || styles.low}`}>
      {level}
    </span>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { socket, connected } = useSocket();
  const [stats, setStats] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/transactions/stats'),
      api.get('/transactions'),
    ]).then(([statsRes, txnRes]) => {
      setStats(statsRes.data);
      setTransactions(txnRes.data.transactions.slice(0, 10));
    }).catch((err) => {
      setError(err.response?.data?.error || 'Failed to load dashboard data');
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Pushed updates instead of polling: the moment the backend scores a
  // new transaction (real or from the Live Feed simulation, see
  // realtime/socketServer.js), it's reflected here without a refresh.
  useEffect(() => {
    if (!socket) return;
    const onTransaction = ({ transaction: txn }) => {
      setTransactions(prev => [txn, ...prev].slice(0, 10));
      setStats(prev => {
        if (!prev) return prev;
        const total = prev.total_transactions + 1;
        const fraudCount = prev.fraud_count + (txn.is_fraud ? 1 : 0);
        return {
          ...prev,
          total_transactions: total,
          fraud_count: fraudCount,
          fraud_rate: parseFloat(((fraudCount / total) * 100).toFixed(2)),
          total_amount: parseFloat((prev.total_amount + Number(txn.amount)).toFixed(2)),
        };
      });
    };
    socket.on('transaction:new', onTransaction);
    return () => socket.off('transaction:new', onTransaction);
  }, [socket]);

  if (loading) return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <LoadingState label="Loading dashboard..." />
    </div>
  );

  if (error) return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <ErrorState message={error} onRetry={load} />
    </div>
  );

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 mt-1">Welcome back, {user?.username}</p>
        </div>
        <div className={`flex items-center gap-2 text-sm ${connected ? 'text-green-400' : 'text-gray-500'}`}>
          {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="Total Transactions" value={stats?.total_transactions ?? 0} icon={Activity} />
        <StatCard title="Fraud Detected" value={stats?.fraud_count ?? 0} icon={AlertTriangle} color="text-red-400" />
        <StatCard title="Total Amount" value={`$${(stats?.total_amount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} icon={DollarSign} color="text-green-400" />
        <StatCard title="Fraud Rate" value={`${stats?.fraud_rate ?? 0}%`} icon={TrendingUp} color={stats?.fraud_rate > 20 ? 'text-red-400' : 'text-yellow-400'} />
      </div>

      <div className="bg-[#161b22] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Recent Transactions</h2>
          <Link to="/transactions" className="text-purple-400 hover:text-purple-300 text-sm transition-colors">View all &rarr;</Link>
        </div>
        {transactions.length === 0 ? (
          <EmptyState icon={Activity} title="No transactions yet" subtitle="Create your first transaction to see it here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-gray-400 text-sm">
                  <th className="text-left px-6 py-3">Merchant</th>
                  <th className="text-left px-6 py-3">Amount</th>
                  <th className="text-left px-6 py-3">Category</th>
                  <th className="text-left px-6 py-3">Risk</th>
                  <th className="text-left px-6 py-3">Score</th>
                  <th className="text-left px-6 py-3">Status</th>
                  <th className="text-left px-6 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(txn => (
                  <tr key={txn.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 text-white font-medium">
                      <Link to={`/transactions/${txn.id}`} className="hover:text-purple-400 transition-colors">{txn.merchant}</Link>
                    </td>
                    <td className="px-6 py-4 text-white">${txn.amount.toFixed(2)}</td>
                    <td className="px-6 py-4 text-gray-300 capitalize">{txn.category}</td>
                    <td className="px-6 py-4"><RiskBadge level={txn.risk_level} /></td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-white/10 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${txn.fraud_score >= 70 ? 'bg-red-500' : txn.fraud_score >= 40 ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${txn.fraud_score}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-400">{txn.fraud_score}%</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {txn.is_fraud ? (
                        <span className="flex items-center gap-1 text-red-400 text-sm"><XCircle size={14} /> Fraud</span>
                      ) : (
                        <span className="flex items-center gap-1 text-green-400 text-sm"><CheckCircle size={14} /> Safe</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-gray-400 text-sm">
                      {new Date(txn.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
