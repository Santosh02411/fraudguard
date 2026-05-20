import React, { useState, useEffect } from 'react';
import { api } from '../context/AuthContext';
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';

export default function AlertsPage() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAlerts = () => {
    setLoading(true);
    api.get('/alerts')
      .then(res => setAlerts(res.data.alerts))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadAlerts(); }, []);

  const resolve = async (id) => {
    try {
      await api.patch(`/alerts/${id}/resolve`);
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to resolve alert');
    }
  };

  const activeAlerts = alerts.filter(a => !a.resolved);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Fraud Alerts</h1>
          <p className="text-gray-400 mt-1">View and manage suspicious transaction alerts</p>
        </div>
        <button
          onClick={loadAlerts}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="bg-[#161b22] border border-white/10 rounded-xl">
        <div className="p-6 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">
            Recent Alerts
            {activeAlerts.length > 0 && (
              <span className="ml-2 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">{activeAlerts.length}</span>
            )}
          </h2>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-400">Loading alerts...</div>
        ) : activeAlerts.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <CheckCircle size={40} className="mx-auto mb-3 text-green-500 opacity-50" />
            <p>No active alerts. All clear!</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {activeAlerts.map(alert => (
              <div key={alert.id} className="flex items-center justify-between p-6 hover:bg-white/5 transition-colors">
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    alert.risk_level === 'high' ? 'bg-red-500/20' : 'bg-yellow-500/20'
                  }`}>
                    <AlertTriangle size={20} className={alert.risk_level === 'high' ? 'text-red-400' : 'text-yellow-400'} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                        alert.risk_level === 'high'
                          ? 'bg-red-500 text-white'
                          : 'bg-yellow-500 text-black'
                      }`}>
                        {alert.risk_level} risk
                      </span>
                      {alert.username && (
                        <span className="text-xs text-gray-500">by {alert.username}</span>
                      )}
                    </div>
                    <p className="text-white text-sm">{alert.message}</p>
                    <p className="text-gray-500 text-xs mt-1">{new Date(alert.created_at).toLocaleString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-white font-semibold">${Number(alert.amount).toFixed(2)}</span>
                  <span className="text-gray-400 text-sm">{alert.merchant}</span>
                  <button
                    onClick={() => resolve(alert.id)}
                    className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm transition-colors"
                  >
                    <CheckCircle size={14} /> Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
