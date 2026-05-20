import React, { useState } from 'react';
import { api } from '../context/AuthContext';
import { CheckCircle, XCircle, AlertTriangle, Shuffle, Send } from 'lucide-react';

const MERCHANTS = ['Amazon', 'Walmart', 'Starbucks', 'Netflix', 'Uber', 'Airbnb', 'Apple Store', 'McDonald\'s', 'Casino Vegas', 'CryptoExchange Pro'];
const CATEGORIES = ['retail', 'food', 'entertainment', 'travel', 'utilities', 'gambling', 'crypto', 'transfer'];
const LOCATIONS = ['New York, US', 'Los Angeles, US', 'Chicago, US', 'London, UK', 'Paris, France', 'Unknown', 'Lagos, Nigeria', 'Tokyo, Japan'];
const CARD_TYPES = ['credit', 'debit', 'prepaid'];

export default function NewTransactionPage() {
  const [form, setForm] = useState({
    amount: '',
    merchant: '',
    category: 'retail',
    location: 'New York, US',
    card_type: 'credit',
  });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const randomize = () => {
    setForm({
      amount: (Math.random() * 4000 + 10).toFixed(2),
      merchant: MERCHANTS[Math.floor(Math.random() * MERCHANTS.length)],
      category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)],
      location: LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)],
      card_type: CARD_TYPES[Math.floor(Math.random() * CARD_TYPES.length)],
    });
    setResult(null);
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const { data } = await api.post('/transactions', form);
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to process transaction');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full bg-[#0d1117] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";
  const labelClass = "block text-sm text-gray-300 mb-1";

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">New Transaction</h1>
        <p className="text-gray-400 mt-1">Submit a transaction for fraud analysis</p>
      </div>

      <div className="bg-[#161b22] border border-white/10 rounded-xl p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold text-white">Transaction Details</h2>
          <button
            type="button"
            onClick={randomize}
            className="flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300 border border-purple-400/30 hover:border-purple-300/50 px-3 py-1.5 rounded-lg transition-colors"
          >
            <Shuffle size={14} /> Random Fill
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Amount ($)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                className={inputClass}
                placeholder="e.g. 150.00"
                required
              />
            </div>
            <div>
              <label className={labelClass}>Merchant</label>
              <input
                type="text"
                value={form.merchant}
                onChange={e => setForm({ ...form, merchant: e.target.value })}
                className={inputClass}
                placeholder="e.g. Amazon"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Category</label>
              <select
                value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                className={inputClass}
              >
                {CATEGORIES.map(c => (
                  <option key={c} value={c} className="bg-[#161b22] capitalize">{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Card Type</label>
              <select
                value={form.card_type}
                onChange={e => setForm({ ...form, card_type: e.target.value })}
                className={inputClass}
              >
                {CARD_TYPES.map(c => (
                  <option key={c} value={c} className="bg-[#161b22] capitalize">{c}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>Location</label>
            <select
              value={form.location}
              onChange={e => setForm({ ...form, location: e.target.value })}
              className={inputClass}
            >
              {LOCATIONS.map(l => (
                <option key={l} value={l} className="bg-[#161b22]">{l}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors mt-2"
          >
            <Send size={16} />
            {loading ? 'Analyzing...' : 'Submit Transaction'}
          </button>
        </form>
      </div>

      {/* Result Panel */}
      {result && (
        <div className={`mt-6 border rounded-xl p-8 ${
          result.analysis.is_fraud
            ? 'bg-red-500/10 border-red-500/40'
            : result.analysis.risk_level === 'medium'
            ? 'bg-yellow-500/10 border-yellow-500/40'
            : 'bg-green-500/10 border-green-500/40'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            {result.analysis.is_fraud ? (
              <XCircle size={32} className="text-red-400" />
            ) : result.analysis.risk_level === 'medium' ? (
              <AlertTriangle size={32} className="text-yellow-400" />
            ) : (
              <CheckCircle size={32} className="text-green-400" />
            )}
            <div>
              <h3 className={`text-xl font-bold ${
                result.analysis.is_fraud ? 'text-red-400' : result.analysis.risk_level === 'medium' ? 'text-yellow-400' : 'text-green-400'
              }`}>
                {result.analysis.message}
              </h3>
              <p className="text-gray-400 text-sm">Transaction ID: #{result.transaction.id}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-black/20 rounded-lg p-4 text-center">
              <p className="text-gray-400 text-xs mb-1">Fraud Score</p>
              <p className="text-2xl font-bold text-white">{result.analysis.fraud_score}%</p>
            </div>
            <div className="bg-black/20 rounded-lg p-4 text-center">
              <p className="text-gray-400 text-xs mb-1">Risk Level</p>
              <p className={`text-2xl font-bold capitalize ${
                result.analysis.risk_level === 'high' ? 'text-red-400' :
                result.analysis.risk_level === 'medium' ? 'text-yellow-400' : 'text-green-400'
              }`}>{result.analysis.risk_level}</p>
            </div>
            <div className="bg-black/20 rounded-lg p-4 text-center">
              <p className="text-gray-400 text-xs mb-1">Amount</p>
              <p className="text-2xl font-bold text-white">${Number(form.amount).toFixed(2)}</p>
            </div>
          </div>

          {result.analysis.fraud_reasons.length > 0 && (
            <div>
              <p className="text-gray-300 text-sm font-semibold mb-2">Risk Factors Detected:</p>
              <ul className="space-y-1">
                {result.analysis.fraud_reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                    <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.analysis.fraud_reasons.length === 0 && (
            <p className="text-green-400 text-sm">No risk factors detected. This transaction appears safe.</p>
          )}
        </div>
      )}
    </div>
  );
}
