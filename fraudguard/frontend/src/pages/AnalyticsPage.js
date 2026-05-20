import React, { useState, useEffect } from 'react';
import { api } from '../context/AuthContext';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';

const COLORS = ['#10b981', '#ef4444', '#f59e0b', '#3b82f6'];

export default function AnalyticsPage() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/transactions')
      .then(res => setTransactions(res.data.transactions))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading analytics...</div>;

  // Category breakdown
  const categoryMap = {};
  transactions.forEach(t => {
    if (!categoryMap[t.category]) categoryMap[t.category] = { category: t.category, count: 0, amount: 0, fraud: 0 };
    categoryMap[t.category].count++;
    categoryMap[t.category].amount += t.amount;
    if (t.is_fraud) categoryMap[t.category].fraud++;
  });
  const categoryData = Object.values(categoryMap).map(c => ({
    ...c,
    amount: parseFloat(c.amount.toFixed(2)),
  }));

  // Risk breakdown for pie
  const riskCount = { low: 0, medium: 0, high: 0 };
  transactions.forEach(t => { riskCount[t.risk_level]++; });
  const pieData = [
    { name: 'Low Risk', value: riskCount.low },
    { name: 'Medium Risk', value: riskCount.medium },
    { name: 'High Risk', value: riskCount.high },
  ].filter(d => d.value > 0);

  // Daily transaction volume (last 7 days)
  const dailyMap = {};
  transactions.forEach(t => {
    const day = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!dailyMap[day]) dailyMap[day] = { day, total: 0, fraud: 0 };
    dailyMap[day].total++;
    if (t.is_fraud) dailyMap[day].fraud++;
  });
  const dailyData = Object.values(dailyMap).slice(-7);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Analytics</h1>
        <p className="text-gray-400 mt-1">Transaction patterns and fraud insights</p>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-[#161b22] border border-white/10 rounded-xl p-12 text-center text-gray-500">
          No transaction data yet. Create some transactions to see analytics.
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Daily volume */}
            <div className="bg-[#161b22] border border-white/10 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Transaction Volume by Day</h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: '#161b22', border: '1px solid #ffffff20', color: '#fff' }} />
                  <Bar dataKey="total" fill="#7c3aed" name="Total" radius={[4,4,0,0]} />
                  <Bar dataKey="fraud" fill="#ef4444" name="Fraud" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Risk breakdown pie */}
            <div className="bg-[#161b22] border border-white/10 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Risk Level Distribution</h2>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {pieData.map((_, i) => <Cell key={i} fill={['#10b981','#f59e0b','#ef4444'][i]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#161b22', border: '1px solid #ffffff20', color: '#fff' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="bg-[#161b22] border border-white/10 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Amount by Category</h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={categoryData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                <YAxis dataKey="category" type="category" tick={{ fill: '#9ca3af', fontSize: 12 }} width={90} />
                <Tooltip contentStyle={{ backgroundColor: '#161b22', border: '1px solid #ffffff20', color: '#fff' }}
                  formatter={(v) => [`$${v.toLocaleString()}`, 'Amount']} />
                <Bar dataKey="amount" fill="#3b82f6" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
