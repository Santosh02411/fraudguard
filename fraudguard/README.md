# 🛡️ FraudGuard — AI-Powered Fraud Detection System

A full-stack fraud detection web application with a React frontend and Node.js/Express backend using SQLite.

---

## 📋 Prerequisites

Make sure you have these installed before starting:

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 18+ | https://nodejs.org |
| npm | 9+ | (comes with Node.js) |

Check your versions:
```bash
node --version   # should show v18.x.x or higher
npm --version    # should show 9.x.x or higher
```

---

## 📁 Project Structure

```
fraudguard/
├── backend/               ← Express API server
│   ├── models/
│   │   ├── db.js          ← SQLite database setup
│   │   └── fraudEngine.js ← Fraud detection logic
│   ├── middleware/
│   │   └── auth.js        ← JWT authentication
│   ├── routes/
│   │   ├── auth.js        ← Login / Register
│   │   ├── transactions.js← Submit & analyze transactions
│   │   ├── alerts.js      ← Fraud alerts
│   │   └── admin.js       ← Admin panel endpoints
│   ├── .env               ← Environment variables
│   ├── server.js          ← Main Express app
│   └── package.json
│
├── frontend/              ← React app
│   ├── src/
│   │   ├── context/
│   │   │   └── AuthContext.js  ← Auth state + Axios setup
│   │   ├── components/
│   │   │   └── Navbar.js
│   │   ├── pages/
│   │   │   ├── LoginPage.js
│   │   │   ├── DashboardPage.js
│   │   │   ├── NewTransactionPage.js
│   │   │   ├── AlertsPage.js
│   │   │   ├── AnalyticsPage.js
│   │   │   └── AdminPage.js
│   │   ├── App.js
│   │   ├── index.js
│   │   └── index.css
│   └── package.json
│
└── README.md
```

---

## 🚀 How to Run (Step by Step)

### Step 1 — Install backend dependencies

Open a terminal, navigate to the project folder, then:

```bash
cd backend
npm install
```

### Step 2 — Start the backend server

```bash
# Still inside the backend/ folder:
npm start
```

You should see:
```
✅ Admin user created: admin / admin123
🛡️  FraudGuard Backend running on http://localhost:5000
📊 API: http://localhost:5000/api/health
```

> ✅ Keep this terminal open. The backend must stay running.

---

### Step 3 — Install frontend dependencies

Open a **second terminal**, navigate to the project folder, then:

```bash
cd frontend
npm install
```

> ⚠️ This takes 2–5 minutes the first time. That's normal.

### Step 4 — Start the frontend

```bash
# Still inside the frontend/ folder:
npm start
```

Your browser should automatically open at **http://localhost:3000**

---

## 🔐 Login Credentials

### Admin Account (pre-created automatically)
- **Username:** `admin`
- **Password:** `admin123`

### Create New Accounts
Click **Register** on the login page to create a regular user account.

---

## 🧪 How to Test the App

### Test a Safe Transaction
1. Log in → click **New Transaction**
2. Fill in:
   - Amount: `50`
   - Merchant: `Starbucks`
   - Category: `food`
   - Location: `New York, US`
   - Card Type: `credit`
3. Click **Submit Transaction**
4. ✅ You'll see: "Transaction looks safe." with a low fraud score

### Test a Fraud Transaction
1. Go to **New Transaction**
2. Fill in:
   - Amount: `3500`
   - Merchant: `CryptoExchange Pro`
   - Category: `crypto`
   - Location: `Unknown`
   - Card Type: `prepaid`
3. Click **Submit Transaction**
4. 🚨 You'll see: "Fraud detected!" with a high fraud score and reasons listed

### Use Random Fill
Click the **Random Fill** button to auto-populate a random transaction.

---

## 📊 Features

| Feature | Description |
|---------|-------------|
| **Dashboard** | Live stats: total transactions, fraud count, fraud rate, transaction history |
| **New Transaction** | Submit transactions manually or with random data; instant fraud analysis |
| **Fraud Alerts** | View all high/medium risk transaction alerts; resolve them when reviewed |
| **Analytics** | Bar charts and pie charts of transaction volume, risk distribution, and category breakdown |
| **Admin Panel** | View all users, their stats, promote/demote user roles |

---

## 🔍 How Fraud Detection Works

The fraud engine (`backend/models/fraudEngine.js`) scores each transaction 0–100 based on:

| Factor | Risk Added | Example |
|--------|-----------|---------|
| Amount > $3000 | +40 points | $3,500 transaction |
| Amount > $1500 | +20 points | $2,000 transaction |
| High-risk merchant | +30 points | CryptoExchange, Casino |
| High-risk category | +25 points | `crypto`, `gambling` |
| High-risk location | +20 points | Unknown, Nigeria |
| Prepaid card | +15 points | Prepaid card type |
| 5+ transactions/hour | +25 points | Velocity check |

**Score → Risk Level:**
- `0–39` → 🟢 **Low Risk** — Safe transaction
- `40–69` → 🟡 **Medium Risk** — Suspicious, review needed
- `70–100` → 🔴 **High Risk** — Fraud flagged, alert created

---

## 🛠️ API Endpoints

All protected routes require `Authorization: Bearer <token>` header.

| Method | Endpoint | Auth | Description |
|--------|---------|------|-------------|
| POST | `/api/auth/register` | None | Create account |
| POST | `/api/auth/login` | None | Login, returns JWT |
| GET | `/api/auth/me` | User | Get current user |
| GET | `/api/transactions` | User | List transactions |
| POST | `/api/transactions` | User | Create + analyze transaction |
| GET | `/api/transactions/stats` | User | Dashboard statistics |
| GET | `/api/alerts` | User | List active alerts |
| PATCH | `/api/alerts/:id/resolve` | User | Resolve an alert |
| GET | `/api/admin/stats` | Admin | System-wide stats |
| GET | `/api/admin/users` | Admin | All users list |
| PATCH | `/api/admin/users/:id/role` | Admin | Change user role |

---

## ⚙️ Configuration

Edit `backend/.env` to change settings:

```env
PORT=5000                          # Backend port (default 5000)
JWT_SECRET=your_secret_here        # Change this in production!
NODE_ENV=development
```

The database file (`fraudguard.db`) is created automatically in the `backend/` folder on first run. No setup needed.

---

## 🐛 Troubleshooting

**"Port 5000 already in use"**
```bash
# Mac/Linux:
lsof -ti:5000 | xargs kill
# Windows:
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**"Cannot find module" error in backend**
```bash
cd backend && npm install
```

**Frontend shows blank page or API errors**
- Make sure the backend is running first (Step 2)
- Check the backend terminal for error messages
- Make sure you're at http://localhost:3000, not 5000

**Login says "Invalid credentials"**
- Default admin: `admin` / `admin123`
- If you changed the DB, delete `backend/fraudguard.db` and restart the backend to reset

**npm install is very slow**
- This is normal for the first install (downloading ~200MB of packages)
- Wait 5 minutes before assuming something is wrong

---

## 📦 Tech Stack

**Backend:** Node.js, Express, better-sqlite3, bcryptjs, jsonwebtoken  
**Frontend:** React 18, React Router v6, Recharts, Lucide React, Tailwind CSS, Axios
