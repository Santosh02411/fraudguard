"""
FraudGuard - ML Scoring Service (FastAPI) v2
================================================
Loads whichever model version is currently PROMOTED in the registry
(models/current_version.json -> models/registry/vN/) and serves:

    POST /predict          - score one transaction, with SHAP explainability
    GET  /health            - service + model status
    GET  /metrics            - evaluation metrics for the active version
    GET  /model/versions     - every version in the registry + which is active
    POST /model/reload       - hot-reload the currently-promoted version
                                (e.g. after train_model.py promotes a new one)
    POST /model/rollback     - force-activate a specific older version

Run:
    uvicorn app:app --host 0.0.0.0 --port 8001 --reload
"""

import json
import os
from collections import deque

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from utils.feature_engineering import engineer_features, align_columns
from utils.drift import compute_drift_report

app = FastAPI(title="FraudGuard ML Service", version="2.0.0")

REGISTRY_DIR = "models/registry"
CURRENT_VERSION_PATH = "models/current_version.json"

# How many recent /predict calls' engineered feature rows (and scores) to
# keep in memory for drift/shadow reporting. In-memory only — resets on
# restart, which is an honest limitation of this being a demo rather
# than shipping to a real metrics store (Prometheus/a time-series DB);
# see GET /metrics for the metrics that DO already go through
# prom-client on the Node side.
LIVE_BUFFER_MAXLEN = 2000
SHADOW_COMPARISON_MAXLEN = 1000
MIN_DRIFT_SAMPLES = 30

STATE = {
    "model": None,
    "scaler": None,
    "feature_columns": None,
    "metrics": None,
    "metadata": None,
    "explainer": None,
    "version": None,
    # --- Drift monitoring (feature: model drift monitoring) ---
    "baseline_stats": None,
    "live_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),   # engineered feature rows
    "score_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),  # corresponding fraud_score values
    # --- Shadow/canary deployment (feature: shadow model deployment) ---
    # A second model version scored in PARALLEL on the same live traffic,
    # purely for comparison — it never influences fraud_score/risk_level
    # in the response. See /model/shadow/* endpoints below.
    "shadow_model": None,
    "shadow_scaler": None,
    "shadow_feature_columns": None,
    "shadow_metadata": None,
    "shadow_version": None,
    "shadow_comparisons": deque(maxlen=SHADOW_COMPARISON_MAXLEN),
}


def _load_version(version: str):
    version_dir = os.path.join(REGISTRY_DIR, version)
    if not os.path.isdir(version_dir):
        raise FileNotFoundError(f"No such model version in registry: {version}")

    model = joblib.load(os.path.join(version_dir, "model.pkl"))
    scaler = joblib.load(os.path.join(version_dir, "scaler.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        feature_columns = json.load(f)
    with open(os.path.join(version_dir, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(version_dir, "metadata.json")) as f:
        metadata = json.load(f)
    background = np.load(os.path.join(version_dir, "background_sample.npy"))

    # shap.Explainer auto-selects TreeExplainer/LinearExplainer/etc. based
    # on the model type — same call works for LogisticRegression,
    # RandomForest, and XGBoost.
    explainer = shap.Explainer(model.predict_proba, background)

    # Drift baseline is optional — older registry versions trained before
    # this feature existed won't have one; GET /model/drift handles that
    # gracefully (see below) instead of failing to load the model at all.
    baseline_stats = None
    baseline_path = os.path.join(version_dir, "baseline_stats.json")
    if os.path.exists(baseline_path):
        with open(baseline_path) as f:
            baseline_stats = json.load(f)

    STATE.update({
        "model": model, "scaler": scaler, "feature_columns": feature_columns,
        "metrics": metrics, "metadata": metadata, "explainer": explainer,
        "version": version, "baseline_stats": baseline_stats,
        # A new primary model means a fresh baseline to compare against —
        # traffic buffered against the OLD model's baseline would produce
        # a meaningless drift report against the new one.
        "live_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),
        "score_buffer": deque(maxlen=LIVE_BUFFER_MAXLEN),
    })
    print(f"Loaded model version {version} ({metadata['best_model_type']}, "
          f"PR-AUC={metadata['pr_auc']})")


def _load_current():
    if not os.path.exists(CURRENT_VERSION_PATH):
        print("WARNING: no current_version.json found. Run train_model.py first.")
        return
    with open(CURRENT_VERSION_PATH) as f:
        current = json.load(f)
    _load_version(current["version"])


def _load_shadow_version(version: str):
    """Loads a registry version into the SHADOW slot, separate from the
    primary model — scored in parallel on every /predict call, but never
    read for the served fraud_score/risk_level. See the module-level
    STATE comment above for why."""
    if version == STATE["version"]:
        raise ValueError("Shadow version must differ from the active primary version")
    version_dir = os.path.join(REGISTRY_DIR, version)
    if not os.path.isdir(version_dir):
        raise FileNotFoundError(f"No such model version in registry: {version}")

    model = joblib.load(os.path.join(version_dir, "model.pkl"))
    scaler = joblib.load(os.path.join(version_dir, "scaler.pkl"))
    with open(os.path.join(version_dir, "feature_columns.json")) as f:
        feature_columns = json.load(f)
    with open(os.path.join(version_dir, "metadata.json")) as f:
        metadata = json.load(f)

    STATE.update({
        "shadow_model": model, "shadow_scaler": scaler,
        "shadow_feature_columns": feature_columns, "shadow_metadata": metadata,
        "shadow_version": version,
    })
    STATE["shadow_comparisons"].clear()
    print(f"Shadow model set to version {version} ({metadata['best_model_type']}) "
          f"— scoring every prediction in parallel, not affecting decisions")


@app.on_event("startup")
def startup():
    try:
        _load_current()
    except Exception as e:
        print(f"WARNING: failed to load model at startup: {e}")


class TransactionIn(BaseModel):
    amount: float
    category: str
    location: str
    card_type: str = Field(default="credit")
    hour: int = Field(default=12, ge=0, le=23)
    day_of_week: int = Field(default=0, ge=0, le=6)
    distance_from_home: float = 0.0
    geo_distance_from_last_km: float = 0.0
    time_since_last_transaction_minutes: float = 1440.0
    ratio_to_median_purchase_price: float = 1.0
    spending_zscore: float = 0.0
    repeat_retailer: int = 0
    used_chip: int = 0
    used_pin_number: int = 0
    online_order: int = 1
    velocity_last_hour: int = 0
    is_new_device: int = 0
    ip_status: str = Field(default="known")  # known | new | unknown


@app.get("/health")
def health():
    return {
        "status": "ok" if STATE["model"] is not None else "model_not_loaded",
        "version": STATE["version"],
        "model_type": STATE["metadata"]["best_model_type"] if STATE["metadata"] else None,
    }


@app.get("/metrics")
def metrics():
    if STATE["metrics"] is None:
        raise HTTPException(503, "Metrics not available. Train the model first.")
    return {"version": STATE["version"], **STATE["metrics"]}


@app.get("/model/versions")
def list_versions():
    if not os.path.isdir(REGISTRY_DIR):
        return {"versions": [], "active": None}
    versions = []
    for name in sorted(os.listdir(REGISTRY_DIR)):
        meta_path = os.path.join(REGISTRY_DIR, name, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                versions.append(json.load(f))
    return {"versions": versions, "active": STATE["version"]}


@app.post("/model/reload")
def reload_model():
    """Re-reads current_version.json and hot-swaps the active model.
    Call this after train_model.py promotes a new version, without
    restarting the service."""
    try:
        _load_current()
        return {"status": "reloaded", "version": STATE["version"]}
    except Exception as e:
        raise HTTPException(500, f"Reload failed: {e}")


class RollbackIn(BaseModel):
    version: str


@app.post("/model/rollback")
def rollback(body: RollbackIn):
    """Force-activates a specific (older) registry version, e.g. if a
    freshly promoted model turns out to misbehave in production."""
    try:
        _load_version(body.version)
        with open(CURRENT_VERSION_PATH, "w") as f:
            json.dump({"version": body.version, "promoted_at": None, "rolled_back": True}, f, indent=2)
        return {"status": "rolled_back", "version": body.version}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


# --- Drift monitoring (feature: model drift monitoring — utils/drift.py) ---

@app.get("/model/drift")
def drift_report():
    """Compares recent live traffic (STATE["live_buffer"]/["score_buffer"],
    populated by every /predict call below) against the distribution the
    active model version was trained on (STATE["baseline_stats"], written
    once by train_model.py). No ground-truth labels needed — see
    utils/drift.py's module docstring for why PSI is the right metric
    for that."""
    if STATE["model"] is None:
        raise HTTPException(503, "Model not loaded.")
    if STATE["baseline_stats"] is None:
        raise HTTPException(
            503,
            "No baseline stats saved for this model version — it was trained "
            "before drift monitoring existed. Retrain with the current "
            "train_model.py to generate models/registry/<version>/baseline_stats.json.",
        )

    n = len(STATE["live_buffer"])
    if n < MIN_DRIFT_SAMPLES:
        return {
            "status": "insufficient_data",
            "version": STATE["version"],
            "n_samples": n,
            "min_required": MIN_DRIFT_SAMPLES,
        }

    live_df = pd.DataFrame(list(STATE["live_buffer"]))
    report = compute_drift_report(STATE["baseline_stats"], live_df, list(STATE["score_buffer"]))
    report["version"] = STATE["version"]
    return report


@app.post("/model/drift/reset")
def drift_reset():
    """Clears the live-traffic buffer without reloading the model —
    useful right after a deliberate traffic-mix change (e.g. a new
    merchant integration) so drift is measured against fresh behavior
    instead of a stale mix."""
    STATE["live_buffer"].clear()
    STATE["score_buffer"].clear()
    return {"status": "reset", "version": STATE["version"]}


# --- Shadow / canary deployment (feature: shadow model deployment) ---

class ShadowSetIn(BaseModel):
    version: str


@app.post("/model/shadow/set")
def set_shadow(body: ShadowSetIn):
    """Starts scoring every /predict call with `body.version` IN
    PARALLEL with the active primary model, purely for comparison —
    the shadow score never affects the response's fraud_score/risk_level.
    This is how a challenger model gets evaluated against real
    production traffic before anyone trusts it to make decisions, not
    just against the fixed held-out test set from training."""
    try:
        _load_shadow_version(body.version)
        return {"status": "shadow_active", "shadow_version": body.version, "primary_version": STATE["version"]}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/model/shadow/clear")
def clear_shadow():
    STATE.update({
        "shadow_model": None, "shadow_scaler": None,
        "shadow_feature_columns": None, "shadow_metadata": None, "shadow_version": None,
    })
    STATE["shadow_comparisons"].clear()
    return {"status": "shadow_cleared"}


@app.get("/model/shadow/status")
def shadow_status():
    if STATE["shadow_version"] is None:
        return {"active": False}

    comps = list(STATE["shadow_comparisons"])
    n = len(comps)
    base = {
        "active": True,
        "shadow_version": STATE["shadow_version"],
        "shadow_model_type": STATE["shadow_metadata"]["best_model_type"] if STATE["shadow_metadata"] else None,
        "primary_version": STATE["version"],
        "primary_model_type": STATE["metadata"]["best_model_type"] if STATE["metadata"] else None,
        "n_compared": n,
    }
    if n == 0:
        return base

    agreement_rate = sum(1 for c in comps if c["agree_risk_level"]) / n
    mean_abs_diff = sum(c["abs_score_diff"] for c in comps) / n
    pct_shadow_higher = sum(1 for c in comps if c["shadow_score"] > c["primary_score"]) / n
    return {
        **base,
        "risk_level_agreement_rate": round(agreement_rate, 4),
        "mean_absolute_score_diff": round(mean_abs_diff, 2),
        "pct_shadow_scored_higher": round(pct_shadow_higher, 4),
    }


@app.post("/model/shadow/promote")
def promote_shadow():
    """Promotes the current shadow version to primary. The payoff of
    running it in parallel first: by the time this is called,
    GET /model/shadow/status already shows how it compared to the
    incumbent on real live traffic, not just on training-time metrics."""
    if STATE["shadow_version"] is None:
        raise HTTPException(400, "No shadow model is currently set — call /model/shadow/set first")
    version = STATE["shadow_version"]
    _load_version(version)  # also resets live_buffer/score_buffer against the new primary's baseline
    with open(CURRENT_VERSION_PATH, "w") as f:
        json.dump({"version": version, "promoted_at": None, "promoted_from_shadow": True}, f, indent=2)
    STATE.update({
        "shadow_model": None, "shadow_scaler": None,
        "shadow_feature_columns": None, "shadow_metadata": None, "shadow_version": None,
    })
    STATE["shadow_comparisons"].clear()
    return {"status": "promoted_from_shadow", "version": version}


@app.post("/predict")
def predict(txn: TransactionIn):
    if STATE["model"] is None:
        raise HTTPException(503, "Model not loaded. Run train_model.py, then restart/reload this service.")

    row = pd.DataFrame([txn.dict()])
    features = engineer_features(row)
    features = align_columns(features, STATE["feature_columns"])
    scaled = STATE["scaler"].transform(features)

    fraud_prob = float(STATE["model"].predict_proba(scaled)[0][1])
    score = round(fraud_prob * 100, 2)

    if score >= 70:
        risk_level = "high"
    elif score >= 40:
        risk_level = "medium"
    else:
        risk_level = "low"

    top_factors = _shap_top_factors(scaled, features.columns.tolist())

    # --- Drift monitoring: record this call's engineered features/score.
    # Best-effort — a buffering hiccup should never break a real scoring
    # response. ---
    try:
        STATE["live_buffer"].append(features.iloc[0].to_dict())
        STATE["score_buffer"].append(score)
    except Exception as e:
        print(f"Drift buffering failed (not affecting the served response): {e}")

    # --- Shadow/canary scoring: run the shadow model on the SAME input,
    # log the comparison, never let it touch the response. Also
    # best-effort for the same reason. ---
    if STATE["shadow_model"] is not None:
        try:
            shadow_features = engineer_features(row)
            shadow_features = align_columns(shadow_features, STATE["shadow_feature_columns"])
            shadow_scaled = STATE["shadow_scaler"].transform(shadow_features)
            shadow_prob = float(STATE["shadow_model"].predict_proba(shadow_scaled)[0][1])
            shadow_score = round(shadow_prob * 100, 2)
            shadow_risk = "high" if shadow_score >= 70 else "medium" if shadow_score >= 40 else "low"
            STATE["shadow_comparisons"].append({
                "primary_score": score,
                "shadow_score": shadow_score,
                "abs_score_diff": abs(score - shadow_score),
                "agree_risk_level": shadow_risk == risk_level,
            })
        except Exception as e:
            print(f"Shadow scoring failed (not affecting the served response): {e}")

    return {
        "fraud_score": score,
        "fraud_probability": round(fraud_prob, 4),
        "risk_level": risk_level,
        "is_fraud": 1 if score >= 70 else 0,
        "model_used": STATE["metadata"]["best_model_type"],
        "model_version": STATE["version"],
        "top_factors": top_factors,
    }


def _shap_top_factors(scaled_row, feature_names, top_n=5):
    """Runs the SHAP explainer for this single prediction and returns the
    features that pushed the score toward FRAUD the most (positive SHAP
    value for the fraud class), in human-readable form. This replaces
    naive weight*value heuristics with a real, theoretically-grounded
    attribution method — the same one used to explain individual
    predictions in production fraud systems.
    """
    try:
        shap_values = STATE["explainer"](scaled_row)
        # shap_values.values shape: (1, n_features, n_classes) for predict_proba-based explainer
        values = shap_values.values[0]
        if values.ndim == 2:
            values = values[:, 1]  # class 1 = fraud
        idx = np.argsort(values)[::-1][:top_n]
        return [
            {
                "feature": _humanize(feature_names[i]),
                "shap_value": round(float(values[i]), 4),
                "effect": "increased_risk" if values[i] > 0 else "decreased_risk",
            }
            for i in idx if abs(values[i]) > 1e-4
        ]
    except Exception as e:
        print(f"SHAP explanation failed: {e}")
        return []


def _humanize(name: str) -> str:
    return (
        name.replace("category_", "category: ")
            .replace("location_", "location: ")
            .replace("card_type_", "card type: ")
            .replace("ip_status_", "IP status: ")
            .replace("_", " ")
    )
