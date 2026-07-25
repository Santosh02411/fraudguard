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
