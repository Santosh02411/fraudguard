"""
FraudGuard - Model Training, Evaluation & Versioning
=======================================================
Trains and compares 3 models (Logistic Regression, Random Forest,
XGBoost), handles class imbalance (class_weight + SMOTE), evaluates on
a held-out test set, and writes the result as a NEW VERSION in the model
registry (models/registry/vN/) rather than overwriting a single file in
place. The new version is only PROMOTED (made the one the API actually
serves) if it beats the currently-promoted version's PR-AUC — otherwise
it's still saved for the record, just not activated. This is the
minimum viable version of what a real MLOps retraining pipeline does:
never blindly ship a new model, always compare against the incumbent.

Registry layout:
    models/registry/v1/
        model.pkl
        scaler.pkl
        feature_columns.json
        background_sample.npy   <- for SHAP explainer at serving time
        metrics.json
        metadata.json           <- version, trained_at, dataset info, promoted?
    models/registry/v2/
        ...
    models/current_version.json <- {"version": "v3"}  <- which one the API loads
    models/training_log.json    <- append-only history of every training run

Run:
    python3 train_model.py                  # regular run, promote if better
    python3 train_model.py --force-promote  # always promote the new version
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    precision_score, recall_score, f1_score, roc_auc_score,
    average_precision_score, confusion_matrix, classification_report,
    roc_curve, precision_recall_curve,
)
from imblearn.over_sampling import SMOTE
from xgboost import XGBClassifier

from utils.feature_engineering import engineer_features, CATEGORY_COLS
from utils.drift import compute_baseline_stats

DATA_PATH = "data/transactions.csv"
REGISTRY_DIR = "models/registry"
CURRENT_VERSION_PATH = "models/current_version.json"
TRAINING_LOG_PATH = "models/training_log.json"
RANDOM_STATE = 42


def load_data():
    df = pd.read_csv(DATA_PATH)
    X = engineer_features(df)
    y = df["is_fraud"].values
    return X, y


def evaluate(name, y_test, y_prob):
    y_pred = (y_prob >= 0.5).astype(int)
    cm = confusion_matrix(y_test, y_pred)
    metrics = {
        "precision": round(precision_score(y_test, y_pred, zero_division=0), 4),
        "recall": round(recall_score(y_test, y_pred, zero_division=0), 4),
        "f1_score": round(f1_score(y_test, y_pred, zero_division=0), 4),
        "roc_auc": round(roc_auc_score(y_test, y_prob), 4),
        "pr_auc": round(average_precision_score(y_test, y_prob), 4),
        "confusion_matrix": {
            "true_negative": int(cm[0][0]), "false_positive": int(cm[0][1]),
            "false_negative": int(cm[1][0]), "true_positive": int(cm[1][1]),
        },
        "classification_report": classification_report(y_test, y_pred, output_dict=True, zero_division=0),
    }
    print(f"\n=== {name} ===")
    print(f"Precision: {metrics['precision']}  Recall: {metrics['recall']}  "
          f"F1: {metrics['f1_score']}  ROC-AUC: {metrics['roc_auc']}  PR-AUC: {metrics['pr_auc']}")
    print(f"Confusion matrix -> TN:{cm[0][0]} FP:{cm[0][1]} FN:{cm[1][0]} TP:{cm[1][1]}")
    return metrics


def next_version() -> str:
    os.makedirs(REGISTRY_DIR, exist_ok=True)
    existing = [d for d in os.listdir(REGISTRY_DIR) if d.startswith("v") and d[1:].isdigit()]
    nums = [int(d[1:]) for d in existing] or [0]
    return f"v{max(nums) + 1}"


def current_promoted_metrics():
    if not os.path.exists(CURRENT_VERSION_PATH):
        return None
    with open(CURRENT_VERSION_PATH) as f:
        current = json.load(f)
    metrics_path = os.path.join(REGISTRY_DIR, current["version"], "metrics.json")
    if not os.path.exists(metrics_path):
        return None
    with open(metrics_path) as f:
        data = json.load(f)
    return data["results"][data["best_model"]]["pr_auc"]


def append_training_log(entry: dict):
    log = []
    if os.path.exists(TRAINING_LOG_PATH):
        with open(TRAINING_LOG_PATH) as f:
            log = json.load(f)
    log.append(entry)
    with open(TRAINING_LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


def train_and_evaluate(force_promote: bool = False, notes: str = ""):
    print("Loading & engineering features...")
    X, y = load_data()
    feature_columns = list(X.columns)
    print(f"Dataset: {len(X)} rows, {len(feature_columns)} features, fraud rate {y.mean():.4%}")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=RANDOM_STATE
    )

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    print(f"\nBefore SMOTE -> class counts: {np.bincount(y_train)}")
    smote = SMOTE(random_state=RANDOM_STATE)
    X_train_smote, y_train_smote = smote.fit_resample(X_train_scaled, y_train)
    print(f"After SMOTE  -> class counts: {np.bincount(y_train_smote)}")

    results, fitted_models, roc_data, pr_data, y_probs = {}, {}, {}, {}, {}

    t0 = time.time()
    lr = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=RANDOM_STATE)
    lr.fit(X_train_scaled, y_train)
    y_prob = lr.predict_proba(X_test_scaled)[:, 1]
    results["logistic_regression"] = evaluate("Logistic Regression (class_weight=balanced)", y_test, y_prob)
    results["logistic_regression"]["train_seconds"] = round(time.time() - t0, 2)
    fitted_models["logistic_regression"] = lr
    y_probs["logistic_regression"] = y_prob
    roc_data["logistic_regression"] = roc_curve(y_test, y_prob)
    pr_data["logistic_regression"] = precision_recall_curve(y_test, y_prob)

    t0 = time.time()
    rf = RandomForestClassifier(
        n_estimators=300, max_depth=12, class_weight="balanced_subsample",
        random_state=RANDOM_STATE, n_jobs=-1,
    )
    rf.fit(X_train_scaled, y_train)
    y_prob = rf.predict_proba(X_test_scaled)[:, 1]
    results["random_forest"] = evaluate("Random Forest (class_weight=balanced_subsample)", y_test, y_prob)
    results["random_forest"]["train_seconds"] = round(time.time() - t0, 2)
    fitted_models["random_forest"] = rf
    y_probs["random_forest"] = y_prob
    roc_data["random_forest"] = roc_curve(y_test, y_prob)
    pr_data["random_forest"] = precision_recall_curve(y_test, y_prob)

    t0 = time.time()
    neg, pos = np.bincount(y_train)
    xgb = XGBClassifier(
        n_estimators=400, max_depth=6, learning_rate=0.05,
        eval_metric="aucpr", scale_pos_weight=neg / pos,
        random_state=RANDOM_STATE, n_jobs=-1,
    )
    xgb.fit(X_train_smote, y_train_smote)
    y_prob = xgb.predict_proba(X_test_scaled)[:, 1]
    results["xgboost"] = evaluate("XGBoost (SMOTE + scale_pos_weight)", y_test, y_prob)
    results["xgboost"]["train_seconds"] = round(time.time() - t0, 2)
    fitted_models["xgboost"] = xgb
    y_probs["xgboost"] = y_prob
    roc_data["xgboost"] = roc_curve(y_test, y_prob)
    pr_data["xgboost"] = precision_recall_curve(y_test, y_prob)

    best_name = max(results, key=lambda k: results[k]["pr_auc"])
    best_model = fitted_models[best_name]
    new_pr_auc = results[best_name]["pr_auc"]
    print(f"\n>>> Best model this run: {best_name} (PR-AUC={new_pr_auc})")

    # --- Version + save to registry ---
    version = next_version()
    version_dir = os.path.join(REGISTRY_DIR, version)
    os.makedirs(version_dir, exist_ok=True)

    joblib.dump(best_model, os.path.join(version_dir, "model.pkl"))
    joblib.dump(scaler, os.path.join(version_dir, "scaler.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json"), "w") as f:
        json.dump(feature_columns, f, indent=2)
    with open(os.path.join(version_dir, "metrics.json"), "w") as f:
        json.dump({"best_model": best_name, "results": results}, f, indent=2)

    # Background sample for SHAP explainer at serving time (small, scaled)
    bg_idx = np.random.RandomState(RANDOM_STATE).choice(len(X_train_scaled), size=min(100, len(X_train_scaled)), replace=False)
    np.save(os.path.join(version_dir, "background_sample.npy"), X_train_scaled[bg_idx])

    # --- Drift baseline (feature: model drift monitoring — utils/drift.py) ---
    # Captures the distribution this version was trained on, so app.py's
    # GET /model/drift can later tell whether live traffic still looks
    # like it. Uses the FULL engineered dataset (X, pre-split) as "what
    # this model considers normal," and the BEST model's own predicted
    # probabilities on the held-out test set as the score baseline —
    # both computed once here, never touched again after this version
    # is written.
    one_hot_prefixes = tuple(f"{c}_" for c in CATEGORY_COLS)
    binary_flag_cols = [
        "repeat_retailer", "is_new_device", "is_high_risk_category",
        "is_high_risk_location", "is_night_txn", "is_rapid_succession",
    ]
    binary_features = [c for c in feature_columns if c in binary_flag_cols or c.startswith(one_hot_prefixes)]
    numeric_features = [c for c in feature_columns if c not in binary_features]
    best_scores = y_probs[best_name] * 100
    score_stats = {
        "mean": float(np.mean(best_scores)),
        "std": float(np.std(best_scores)) or 1.0,
        "high_risk_rate": float(np.mean(best_scores >= 70)),
    }
    baseline_stats = compute_baseline_stats(X, numeric_features, binary_features, score_stats=score_stats)
    with open(os.path.join(version_dir, "baseline_stats.json"), "w") as f:
        json.dump(baseline_stats, f, indent=2)

    # --- Decide whether to promote ---
    prev_pr_auc = current_promoted_metrics()
    promote = force_promote or prev_pr_auc is None or new_pr_auc >= prev_pr_auc
    metadata = {
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "best_model_type": best_name,
        "pr_auc": new_pr_auc,
        "previous_promoted_pr_auc": prev_pr_auc,
        "promoted": promote,
        "n_rows": len(X),
        "n_features": len(feature_columns),
        "fraud_rate": round(float(y.mean()), 4),
        "notes": notes,
    }
    with open(os.path.join(version_dir, "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    if promote:
        with open(CURRENT_VERSION_PATH, "w") as f:
            json.dump({"version": version, "promoted_at": metadata["trained_at"]}, f, indent=2)
        print(f">>> PROMOTED {version} to production "
              f"(PR-AUC {new_pr_auc} vs previous {prev_pr_auc})")
    else:
        print(f">>> NOT promoted: {version} (PR-AUC {new_pr_auc}) did not beat "
              f"current production model (PR-AUC {prev_pr_auc}). Still saved in registry.")

    append_training_log(metadata)

    # --- Plots (saved per-version so history is preserved) ---
    reports_dir = os.path.join("reports", version)
    os.makedirs(reports_dir, exist_ok=True)
    _plot_confusion_matrices(results, reports_dir)
    _plot_roc_pr_curves(roc_data, pr_data, results, reports_dir)
    if hasattr(fitted_models["xgboost"], "feature_importances_"):
        _plot_feature_importance(fitted_models["xgboost"], feature_columns, reports_dir)

    print(f"\nSaved version {version} -> {version_dir}/")
    print(f"Saved plots -> {reports_dir}/")
    return version, promote, metadata


def _plot_confusion_matrices(results, out_dir):
    fig, axes = plt.subplots(1, 3, figsize=(15, 4))
    for ax, (name, res) in zip(axes, results.items()):
        cm = res["confusion_matrix"]
        matrix = np.array([[cm["true_negative"], cm["false_positive"]],
                            [cm["false_negative"], cm["true_positive"]]])
        ax.imshow(matrix, cmap="Blues")
        ax.set_title(name.replace("_", " ").title())
        ax.set_xticks([0, 1]); ax.set_xticklabels(["Pred Legit", "Pred Fraud"])
        ax.set_yticks([0, 1]); ax.set_yticklabels(["Actual Legit", "Actual Fraud"])
        for i in range(2):
            for j in range(2):
                ax.text(j, i, matrix[i, j], ha="center", va="center", fontsize=12)
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "confusion_matrices.png"), dpi=120)
    plt.close()


def _plot_roc_pr_curves(roc_data, pr_data, results, out_dir):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    for name, (fpr, tpr, _) in roc_data.items():
        ax1.plot(fpr, tpr, label=f"{name} (AUC={results[name]['roc_auc']})")
    ax1.plot([0, 1], [0, 1], "k--", alpha=0.3)
    ax1.set_xlabel("False Positive Rate"); ax1.set_ylabel("True Positive Rate")
    ax1.set_title("ROC Curves"); ax1.legend(fontsize=8)

    for name, (prec, rec, _) in pr_data.items():
        ax2.plot(rec, prec, label=f"{name} (PR-AUC={results[name]['pr_auc']})")
    ax2.set_xlabel("Recall"); ax2.set_ylabel("Precision")
    ax2.set_title("Precision-Recall Curves"); ax2.legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "roc_pr_curves.png"), dpi=120)
    plt.close()


def _plot_feature_importance(model, feature_columns, out_dir, top_n=15):
    importances = model.feature_importances_
    idx = np.argsort(importances)[-top_n:]
    plt.figure(figsize=(8, 6))
    plt.barh([feature_columns[i] for i in idx], importances[idx])
    plt.title("XGBoost - Top Feature Importances")
    plt.tight_layout()
    plt.savefig(os.path.join(out_dir, "feature_importance.png"), dpi=120)
    plt.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force-promote", action="store_true",
                         help="Promote the new version even if it doesn't beat the current one")
    parser.add_argument("--notes", type=str, default="", help="Free-text note for the training log")
    args = parser.parse_args()
    train_and_evaluate(force_promote=args.force_promote, notes=args.notes)
