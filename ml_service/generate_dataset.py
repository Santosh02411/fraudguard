"""
FraudGuard - Synthetic Transaction Dataset Generator (v2)
=============================================================
v1 generated independent rows. v2 simulates realistic PER-USER
transaction SEQUENCES over time, because several of the strongest fraud
signals are inherently sequential and can't be generated per-row:

    - transaction velocity (txns in the last hour)
    - time since the user's previous transaction
    - spending-pattern deviation (z-score vs. the user's own rolling mean/std)
    - geo-distance jump from the user's previous transaction location
    - "new device" / "new IP" (requires a per-user device/IP history)

For each of N synthetic users we simulate a sequence of transactions
across ~90 days: mostly consistent behavior (same 1-2 devices, home
location, typical spend range), with a small fraction of transactions
replaced by injected fraud anomalies (new device, IP the user has never
used, a location far from their last transaction, a spend far outside
their normal range, sometimes clustered in a rapid burst).

Run:
    python3 generate_dataset.py --n_users 3000 --out data/transactions.csv
"""

import argparse
import uuid
from collections import deque
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from utils.geo import LOCATION_COORDS, haversine_km

RNG = np.random.default_rng(42)

MERCHANT_CATEGORIES = [
    "grocery", "food", "electronics", "travel", "entertainment",
    "utilities", "clothing", "health", "crypto", "gambling", "wire_transfer",
]
HIGH_RISK_CATEGORIES = {"crypto", "gambling", "wire_transfer"}
LOCATIONS = list(LOCATION_COORDS.keys())
SAFE_LOCATIONS = [l for l in LOCATIONS if l not in ("Unknown", "Anonymous Proxy")]
CARD_TYPES = ["credit", "debit", "prepaid"]

# Kept in sync with backend/scripts/demoVocabulary.js's MERCHANTS_BY_CATEGORY
# so "repeat_retailer" means the same thing in training as it does at
# serving time: this exact merchant appeared in the user's own recent
# transaction history — NOT "this category is one the user likes." Using
# category-membership as a proxy for repeat_retailer made it a near-perfect
# (and spurious) predictor in an earlier version of this generator: legit
# transactions almost always drew from the user's declared preferred
# categories (repeat_retailer≈1) while fraud almost never did
# (repeat_retailer≈0), so the model learned "not a repeat retailer" as a
# near-certain fraud signal — which falsely flags every real user's FIRST
# transaction at any given merchant, fraud or not.
MERCHANTS_BY_CATEGORY = {
    "grocery": ["Whole Foods", "Trader Joe's", "Kroger", "Safeway"],
    "food": ["Starbucks", "McDonald's", "Chipotle", "DoorDash"],
    "electronics": ["Apple Store", "Best Buy", "Amazon", "Newegg"],
    "travel": ["Airbnb", "United Airlines", "Marriott", "Uber"],
    "entertainment": ["Netflix", "Spotify", "AMC Theatres", "Steam"],
    "utilities": ["ConEd", "Verizon", "Comcast", "National Grid"],
    "clothing": ["Zara", "Nike", "Nordstrom", "Levi's"],
    "health": ["CVS Pharmacy", "Walgreens", "One Medical", "GNC"],
    "crypto": ["CryptoExchange Pro", "CoinDesk Trading", "BitVault"],
    "gambling": ["Casino Vegas", "BetStream Live", "PokerRoyale"],
    "wire_transfer": ["QuickCoin Anonymous", "FastCash Wire Instant", "GlobalWire Transfer"],
}


def _cat_probs(fraud: bool):
    n = len(MERCHANT_CATEGORIES)
    base = np.ones(n)
    for i, c in enumerate(MERCHANT_CATEGORIES):
        if c in HIGH_RISK_CATEGORIES:
            base[i] = 7.0 if fraud else 0.3
    return base / base.sum()


def simulate_user(user_id: int, days: int, fraud_prob: float):
    home_location = RNG.choice(SAFE_LOCATIONS)
    known_devices = {f"dev-{uuid.uuid4().hex[:8]}"}
    typical_amount_mean = RNG.uniform(20, 200)
    typical_amount_std = typical_amount_mean * 0.35
    preferred_categories = list(RNG.choice(
        [c for c in MERCHANT_CATEGORIES if c not in HIGH_RISK_CATEGORIES],
        size=int(RNG.integers(2, 5)), replace=False,
    ))
    card_type = RNG.choice(CARD_TYPES, p=[0.55, 0.40, 0.05])

    n_txns = int(RNG.integers(15, 90))
    start = datetime(2026, 1, 1) + timedelta(days=int(RNG.integers(0, 30)))
    timestamps = sorted(
        start + timedelta(minutes=float(m))
        for m in RNG.uniform(0, days * 24 * 60, size=n_txns)
    )

    rows = []
    history_amounts = []
    # Mirrors the live app's `recentTxns` query (LIMIT 20) — repeat_retailer
    # is computed from this exact rolling window, the same way mlClient.js
    # computes it at serving time, so training and serving agree on what
    # the feature means.
    merchant_history = deque(maxlen=20)
    prev_location = home_location
    prev_ts = None

    for ts in timestamps:
        is_fraud = 1 if RNG.random() < fraud_prob else 0
        # Small chance to flip the "signal strength" independent of label,
        # simulating investigator/label noise and genuinely ambiguous cases
        # that exist in every real fraud dataset.
        ambiguous = RNG.random() < 0.08

        if is_fraud:
            # Not every fraud case looks maximally suspicious — mix in
            # "quieter" fraud (e.g. account takeover using the victim's
            # real device/network) so the classes aren't perfectly
            # separable, which is what real fraud data looks like.
            uses_known_device = True if ambiguous else RNG.random() < 0.30
            uses_known_ip = True if ambiguous else RNG.random() < 0.20
            stays_local = True if ambiguous else RNG.random() < 0.25
            moderate_spend = True if ambiguous else RNG.random() < 0.35

            amount = float(RNG.lognormal(mean=6.2 if not moderate_spend else 5.0,
                                          sigma=1.0 if not moderate_spend else 0.6))
            category = RNG.choice(MERCHANT_CATEGORIES, p=_cat_probs(fraud=True))
            merchant = RNG.choice(MERCHANTS_BY_CATEGORY[category])
            if stays_local:
                location = prev_location
            else:
                location = RNG.choice(
                    [l for l in SAFE_LOCATIONS if l != prev_location] + ["Unknown", "Anonymous Proxy"]
                )
            device_id = (
                RNG.choice(list(known_devices)) if (uses_known_device and known_devices)
                else f"dev-{uuid.uuid4().hex[:8]}"
            )
            ip_status = "known" if uses_known_ip else RNG.choice(["new", "unknown"], p=[0.35, 0.65])
            # This app is card-not-present / online-only (see mlClient.js:
            # every live transaction sends online_order=1, used_chip=0,
            # used_pin_number=0 as constants) — so these carry NO
            # discriminative information in production and must be
            # constants in training too, or the model learns a "signal"
            # from a feature that never actually varies once deployed.
            online_order = 1
            used_chip = 0
            used_pin = 0
            # occasionally cluster fraud into a rapid burst (card testing)
            if prev_ts is not None and RNG.random() < 0.4:
                ts = prev_ts + timedelta(minutes=float(RNG.uniform(1, 8)))
        else:
            amount = float(np.clip(RNG.normal(typical_amount_mean, typical_amount_std), 2, None))
            # Occasional legitimate big-ticket purchase (travel, electronics)
            # so "large amount" alone isn't a perfect fraud tell.
            if RNG.random() < 0.05 or ambiguous:
                amount *= float(RNG.uniform(3, 6))
            category = RNG.choice(preferred_categories)
            merchant = RNG.choice(MERCHANTS_BY_CATEGORY[category])
            location = home_location if (RNG.random() < 0.9 and not ambiguous) else RNG.choice(SAFE_LOCATIONS)
            if (RNG.random() < 0.95 and not ambiguous) or len(known_devices) == 0:
                device_id = RNG.choice(list(known_devices))
            else:
                device_id = f"dev-{uuid.uuid4().hex[:8]}"  # legit new device (new phone etc.) or ambiguous case
            ip_status = "new" if ambiguous else ("known" if RNG.random() < 0.85 else "new")
            online_order = 1
            used_chip = 0
            used_pin = 0
            # Rare legitimate rapid-succession burst (shopping spree)
            if prev_ts is not None and (RNG.random() < 0.03 or ambiguous):
                ts = prev_ts + timedelta(minutes=float(RNG.uniform(1, 8)))

        # Genuine repeat-retailer signal: has THIS user transacted with
        # THIS exact merchant in their last 20 transactions? Computed the
        # same way for fraud and legit — no artificial forcing — so it's
        # naturally usually 0 for fraud (attacker doesn't know the user's
        # merchant history) and usually 1 for routine legit spending
        # (people buy from the same handful of places repeatedly), without
        # being a deterministic proxy for the label itself.
        repeat_retailer = int(merchant in merchant_history)

        is_new_device = 0 if device_id in known_devices else 1
        known_devices.add(device_id)

        # --- sequential features computed from this user's own history ---
        time_since_last_min = (
            (ts - prev_ts).total_seconds() / 60.0 if prev_ts is not None else 1440.0
        )
        velocity_last_hour = sum(
            1 for r in rows if 0 <= (ts - r["_ts"]).total_seconds() <= 3600
        )
        if len(history_amounts) >= 3:
            mean_ = np.mean(history_amounts)
            std_ = np.std(history_amounts) or 1.0
            spending_zscore = float((amount - mean_) / std_)
            ratio_to_median = float(amount / (np.median(history_amounts) or 1.0))
        else:
            spending_zscore = 0.0
            ratio_to_median = 1.0

        geo_distance_from_last_km = haversine_km(prev_location, location)
        distance_from_home = haversine_km(home_location, location)

        rows.append({
            "_ts": ts,
            "transaction_id": f"TXN{uuid.uuid4().hex[:10]}",
            "user_synthetic_id": user_id,
            "timestamp": ts.isoformat(),
            "amount": round(amount, 2),
            "merchant": merchant,
            "category": category,
            "location": location,
            "card_type": card_type,
            "hour": ts.hour,
            "day_of_week": ts.weekday(),
            "distance_from_home": distance_from_home,
            "geo_distance_from_last_km": geo_distance_from_last_km,
            "time_since_last_transaction_minutes": round(time_since_last_min, 1),
            "ratio_to_median_purchase_price": round(ratio_to_median, 3),
            "spending_zscore": round(spending_zscore, 3),
            "velocity_last_hour": velocity_last_hour,
            "repeat_retailer": repeat_retailer,
            "used_chip": used_chip,
            "used_pin_number": used_pin,
            "online_order": online_order,
            "is_new_device": is_new_device,
            "ip_status": ip_status,
            "is_fraud": is_fraud,
        })
        history_amounts.append(amount)
        merchant_history.append(merchant)
        prev_location = location
        prev_ts = ts

    return rows


def generate(n_users: int, days: int, fraud_prob: float) -> pd.DataFrame:
    all_rows = []
    for uid in range(n_users):
        all_rows.extend(simulate_user(uid, days, fraud_prob))
    df = pd.DataFrame(all_rows).drop(columns=["_ts"])
    df = df.sample(frac=1.0, random_state=42).reset_index(drop=True)
    return df


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n_users", type=int, default=3000)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--fraud_prob", type=float, default=0.015,
                         help="per-transaction probability of being fraud")
    parser.add_argument("--out", type=str, default="data/transactions.csv")
    args = parser.parse_args()

    df = generate(args.n_users, args.days, args.fraud_prob)
    df.to_csv(args.out, index=False)
    print(f"Generated {len(df)} rows from {args.n_users} synthetic users -> {args.out}")
    print(f"Fraud rate: {df['is_fraud'].mean():.4%}  ({df['is_fraud'].sum()} fraud / {len(df)} total)")
