"""
FraudGuard - Retraining Pipeline
====================================
Orchestrates a full retrain cycle, the way you'd wire this into a cron
job / CI schedule in production:

    1. Generate fresh transaction data (optionally simulating fraud
       pattern DRIFT — new fraud behavior the current model has never
       seen, e.g. a shift toward gambling-category fraud).
    2. Train + evaluate all 3 models on it (train_model.py's logic).
    3. Compare the new best model's PR-AUC against the currently
       promoted version. Only promote if it's actually better (unless
       --force-promote is passed).
    4. If a live ML service is reachable, tell it to hot-reload the
       newly promoted version via POST /model/reload — no restart needed.

Run:
    python3 retrain_pipeline.py
    python3 retrain_pipeline.py --simulate-drift --notes "monthly retrain"
    python3 retrain_pipeline.py --force-promote   # ship regardless of metric
"""

import argparse
import sys

import requests

from generate_dataset import generate
from train_model import train_and_evaluate, DATA_PATH

ML_SERVICE_URL = "http://localhost:8001"


def run(n_users: int, days: int, fraud_prob: float, simulate_drift: bool,
        force_promote: bool, notes: str):
    print("=" * 60)
    print("STEP 1/3 — Generating fresh transaction data")
    print("=" * 60)
    if simulate_drift:
        # Simulate fraud patterns shifting over time: fraud becomes more
        # frequent and skews further toward high-risk categories/locations.
        # A model trained only on the old distribution should degrade
        # here — that's the point of having a retraining pipeline at all.
        fraud_prob = fraud_prob * 1.6
        print(f"(drift simulation enabled — fraud_prob bumped to {fraud_prob:.4f})")
    df = generate(n_users, days, fraud_prob)
    df.to_csv(DATA_PATH, index=False)
    print(f"Generated {len(df)} rows, fraud rate {df['is_fraud'].mean():.4%}")

    print("\n" + "=" * 60)
    print("STEP 2/3 — Training & evaluating candidate models")
    print("=" * 60)
    version, promoted, metadata = train_and_evaluate(
        force_promote=force_promote,
        notes=notes or ("drift-simulated retrain" if simulate_drift else "scheduled retrain"),
    )

    print("\n" + "=" * 60)
    print("STEP 3/3 — Reloading live ML service (if reachable)")
    print("=" * 60)
    if promoted:
        try:
            resp = requests.post(f"{ML_SERVICE_URL}/model/reload", timeout=3)
            resp.raise_for_status()
            print(f"Live service reloaded -> now serving {resp.json()['version']}")
        except Exception as e:
            print(f"Could not reach live ML service to hot-reload ({e}). "
                  f"It will pick up {version} on its next restart, "
                  f"or call POST /model/reload manually.")
    else:
        print(f"{version} was not promoted (didn't beat the current production "
              f"model) — nothing to reload.")

    print("\nDone.")
    return version, promoted


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n_users", type=int, default=3000)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--fraud_prob", type=float, default=0.015)
    parser.add_argument("--simulate-drift", action="store_true",
                         help="Simulate fraud patterns evolving, to demonstrate retraining actually matters")
    parser.add_argument("--force-promote", action="store_true")
    parser.add_argument("--notes", type=str, default="")
    args = parser.parse_args()

    try:
        run(args.n_users, args.days, args.fraud_prob, args.simulate_drift,
            args.force_promote, args.notes)
    except Exception as e:
        print(f"Retraining pipeline FAILED: {e}")
        sys.exit(1)
