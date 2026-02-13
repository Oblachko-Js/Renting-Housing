from fastapi import FastAPI, HTTPException, Request
import os
import psycopg2
import json
from collections import defaultdict
from dateutil import parser
from datetime import datetime, timedelta, date
import math
import pandas as pd
import numpy as np
import joblib
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import cross_val_score, RandomizedSearchCV, train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.inspection import permutation_importance
from tqdm import tqdm
import scipy.stats as stats
import math

app = FastAPI()

DB_USER = os.environ.get("PG_USER", os.environ.get("PGUSER", "andrey"))
DB_PASSWORD = os.environ.get("PG_PASSWORD", os.environ.get("PGPASSWORD", ""))
DB_HOST = os.environ.get("PG_HOST", os.environ.get("PGHOST", "localhost"))
DB_PORT = int(os.environ.get("PG_PORT", os.environ.get("PGPORT", 5432)))
DB_NAME = os.environ.get("PG_DB", os.environ.get("PGDATABASE", "myprogram"))

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.joblib")
PIPE_PATH = os.path.join(os.path.dirname(__file__), "pipeline.joblib")
SYN_CSV = os.path.join(os.path.dirname(__file__), "spb_rent_realistic.csv")

SEASONS = {"winter": [12, 1, 2], "spring": [3, 4, 5], "summer": [6, 7, 8], "autumn": [9, 10, 11]}


def get_conn():
    return psycopg2.connect(user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT, dbname=DB_NAME)


def month_to_season(m):
    for s, months in SEASONS.items():
        if m in months:
            return s
    return "spring"




@app.get("/health")
def health():
    return {"status": "ok"}


def load_synthetic(or_generate=True, n=1000):
    # try load CSV first
    try:
        df = pd.read_csv(SYN_CSV)
        return df
    except Exception:
        if or_generate:
            # lazy import of generator
            try:
                from .generate_synthetic import generate_synthetic
            except ImportError:
                from generate_synthetic import generate_synthetic
            df = generate_synthetic(N=n, out_csv=True, out_path=SYN_CSV)
            return df
        raise


def assemble_db_df(conn, synth_stats=None):
    # Pull minimal fields from DB and enrich with reasonable defaults using synthetic stats
    cur = conn.cursor()
    cur.execute("SELECT id, price, rooms, housing_type, district, lat, lng, amenities, title, description FROM listings")
    rows = cur.fetchall()

    # aggregate reviews
    cur.execute("SELECT listing_id, AVG(rating)::numeric AS avg_rating, COUNT(*) AS reviews_count FROM reviews GROUP BY listing_id")
    rev_rows = cur.fetchall()
    rev_map = {r[0]: {'avg': float(r[1]) if r[1] is not None else 0.0, 'count': int(r[2])} for r in rev_rows}

    # bookings in last 365 days and avg booking length
    cur.execute("SELECT listing_id, COUNT(*) AS bookings_last_year, AVG((end_date - start_date)) AS avg_len FROM bookings WHERE status = 'approved' AND start_date >= (current_date - interval '365 days') GROUP BY listing_id")
    bk_rows = cur.fetchall()
    bk_map = {}
    for r in bk_rows:
        lid = r[0]
        count = int(r[1])
        avg_len = r[2]
        avg_len_days = 0
        if avg_len is None:
            avg_len_days = 0
        else:
            try:
                # if interval-like with .days
                avg_len_days = avg_len.days
            except Exception:
                try:
                    avg_len_days = int(float(avg_len))
                except Exception:
                    avg_len_days = 0
        bk_map[lid] = {'count': count, 'avg_len_days': avg_len_days}

    # bookings last 30 days
    cur.execute("SELECT listing_id, COUNT(*) AS bookings_last_30 FROM bookings WHERE status = 'approved' AND start_date >= (current_date - interval '30 days') GROUP BY listing_id")
    bk30 = cur.fetchall()
    bk30_map = {r[0]: int(r[1]) for r in bk30}

    # listing views
    cur.execute("SELECT listing_id, COUNT(*) AS views_count FROM listing_views GROUP BY listing_id")
    v_rows = cur.fetchall()
    v_map = {r[0]: int(r[1]) for r in v_rows}

    # median price per district (recent listings)
    cur.execute("SELECT district, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) as median_price FROM listings WHERE price IS NOT NULL GROUP BY district")
    med_rows = cur.fetchall()
    med_map = { (r[0] or ''): float(r[1]) for r in med_rows }

    # created_at / days since created
    cur.execute("SELECT id, created_at FROM listings WHERE created_at IS NOT NULL")
    created_rows = cur.fetchall()
    created_map = { r[0]: r[1] for r in created_rows }

    recs = []
    for r in rows:
        lid, price, rooms, housing_type, district, lat, lng, amenities, title, description = r
        rec = {}
        rec['price'] = float(price) if price is not None else np.nan
        rec['area'] = float(synth_stats['area_median']) + np.random.normal(0,5)
        rec['rooms'] = int(rooms) if rooms is not None else int(synth_stats['rooms_mode'])
        rec['floor'] = int(np.clip(np.random.randint(1, max(2, int(synth_stats['floors_total_mean'])+1)),1,50))
        rec['floors_total'] = int(max(2, int(synth_stats['floors_total_mean'])))
        rec['district'] = district if district else ''
        rec['metro_station'] = ''
        rec['metro_distance_min'] = float(synth_stats['metro_distance_mean'])
        rec['renovation_quality'] = 'косметический'
        rec['furniture'] = 'частично'
        rec['month'] = int(datetime.utcnow().month)
        rec['latitude'] = float(lat) if lat else float(synth_stats['latitude_mean'])
        rec['longitude'] = float(lng) if lng else float(synth_stats['longitude_mean'])
        rec['center_distance_km'] = float(synth_stats['center_distance_mean'])
        rec['metro_distance_min'] = int(synth_stats.get('metro_distance_median', 300))  # default ~5-10 min walk
        rec['build_year'] = int(synth_stats['build_year_median'])
        rec['house_age'] = 2024 - rec['build_year']
        # amenities string => count
        if amenities:
            try:
                ams = [x.strip() for x in amenities.split(',') if x.strip()]
                rec['amenities_count'] = len(ams)
            except Exception:
                rec['amenities_count'] = int(synth_stats['amenities_count_mean'])
        else:
            rec['amenities_count'] = int(synth_stats['amenities_count_mean'])
        # text fields
        rec['title'] = title if title else ''
        rec['description'] = description if description else ''
        rec['text'] = (rec['title'] + ' ' + rec['description']).strip()
        rec['title_len'] = len(rec['title'])
        rec['desc_len'] = len(rec['description'])
        # simple keyword flags
        txt = (rec['text'] or '').lower()
        rec['has_word_remont'] = 1 if any(w in txt for w in ['ремонт','евроремонт','дизайн','дизайнерский']) else 0
        rec['has_word_mebel'] = 1 if any(w in txt for w in ['мебел','полностью']) else 0
        rec['has_word_novostroi'] = 1 if any(w in txt for w in ['новостро','новострой']) else 0

        # additional aggregated features from DB
        rev = rev_map.get(lid, {'avg': 0.0, 'count': 0})
        rec['avg_rating'] = float(rev['avg'])
        rec['reviews_count'] = int(rev['count'])
        bk = bk_map.get(lid, {'count': 0, 'avg_len_days': 0})
        rec['bookings_last_year'] = int(bk.get('count', 0))
        rec['avg_booking_length'] = int(bk.get('avg_len_days', 0))
        rec['bookings_last_30'] = int(bk30_map.get(lid, 0))
        rec['views_count'] = int(v_map.get(lid, 0))
        # median district price
        rec['median_price_district'] = float(med_map.get(rec['district'] or '', med_map.get('', float(synth_stats['price_per_sqm_mean']*rec['area']))))
        # created_at -> days since
        created = created_map.get(lid)
        if created:
            try:
                days_since = (datetime.utcnow().date() - created).days if hasattr(created, 'date') else (datetime.utcnow().date() - created).days
            except Exception:
                days_since = 0
        else:
            days_since = 0
        rec['days_since_created'] = int(days_since)

        # derived
        rec['price_per_sqm'] = rec['price'] / rec['area'] if rec['price'] and rec['area'] else float(synth_stats['price_per_sqm_mean'])
        rec['floor_ratio'] = rec['floor'] / rec['floors_total']
        rec['is_new_building'] = 1 if rec['build_year'] >= 2010 else 0
        rec['is_center'] = 1 if rec['center_distance_km'] <= 3 else 0
        rec['is_high_floor'] = 1 if rec['floor_ratio'] > 0.7 else 0
        rec['is_summer'] = 1 if rec['month'] in [6,7,8] else 0
        rec['is_winter'] = 1 if rec['month'] in [12,1,2] else 0
        rec['area_rooms_interaction'] = rec['area'] * rec['rooms']
        rec['center_new_interaction'] = rec['is_center'] * rec['is_new_building']
        rec['metro_center_interaction'] = rec['metro_distance_min'] * rec['center_distance_km']
        recs.append(rec)
    df = pd.DataFrame(recs)
    return df


def compute_synth_stats(df):
    return {
        'area_median': float(df['area'].median()),
        'rooms_mode': int(df['rooms'].mode().iloc[0]),
        'floors_total_mean': float(df['floors_total'].mean()),
        'metro_distance_mean': float(df['metro_distance_min'].mean()),
        'metro_distance_median': float(df['metro_distance_min'].median()),
        'latitude_mean': float(df['latitude'].mean()),
        'longitude_mean': float(df['longitude'].mean()),
        'center_distance_mean': float(df['center_distance_km'].mean()),
        'build_year_median': int(df['build_year'].median()),
        'amenities_count_mean': int(df['amenities_count'].mean()),
        'price_per_sqm_mean': float(df['price_per_sqm'].mean())
    }


@app.post('/train_model')
def train_model_endpoint(samples:int=1000, tune:bool=False, n_iter:int=20, use_log:bool=False, test_size:float=0.15, random_state:int=42):
    """Train ML model (CatBoost) using synthetic + DB data and save pipeline.
    Keep it simple: optional RandomizedSearchCV tuning (n_iter limited to 40).
    """
    try:
        synth = load_synthetic(or_generate=True, n=samples)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get synthetic data: {e}")
    synth_stats = compute_synth_stats(synth)
    try:
        conn = get_conn()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB connection error: {e}")
    db_df = assemble_db_df(conn, synth_stats=synth_stats)
    db_df = db_df[~db_df['price'].isnull()]

    # concat datasets
    df = pd.concat([synth, db_df], ignore_index=True, sort=False)

    # features & target
    features = ['area','rooms','floor','floors_total','district','metro_distance_min','renovation_quality','furniture','month','latitude','longitude','center_distance_km','build_year','amenities_count','is_summer','is_winter','avg_rating','reviews_count','bookings_last_year','avg_booking_length','bookings_last_30','views_count','median_price_district','days_since_created']
    df['price_per_sqm'] = df['price'] / df['area']
    df['floor_ratio'] = df['floor'] / df['floors_total']
    features += ['price_per_sqm','floor_ratio']

    # ===== KEY FEATURES: area, center_distance, metro_distance =====
    # Convert metro distance to km for consistency
    df['metro_distance_km'] = df['metro_distance_min'] / 1000.0

    # Add polynomial and interaction features for center distance
    df['center_dist_sq'] = df['center_distance_km'] ** 2
    df['center_dist_log'] = np.log1p(df['center_distance_km'])
    df['center_dist_inv'] = 1.0 / (1.0 + df['center_distance_km'])  # closer = higher value
    features += ['center_dist_sq', 'center_dist_log', 'center_dist_inv']

    # Add polynomial features for metro distance
    df['metro_dist_sq'] = df['metro_distance_km'] ** 2
    df['metro_dist_log'] = np.log1p(df['metro_distance_km'])
    df['metro_dist_inv'] = 1.0 / (1.0 + df['metro_distance_km'])  # closer = higher value
    features += ['metro_dist_sq', 'metro_dist_log', 'metro_dist_inv']

    # ===== KEY INTERACTIONS: boost importance of area + location =====
    # Area inversely affects distance value (larger area farther from center is still premium)
    df['area_x_center_inv'] = df['area'] * df['center_dist_inv']  # area * proximity_to_center
    df['area_x_metro_inv'] = df['area'] * df['metro_dist_inv']    # area * proximity_to_metro
    df['center_metro_proximity'] = df['center_dist_inv'] * df['metro_dist_inv']  # both locations matter
    features += ['area_x_center_inv', 'area_x_metro_inv', 'center_metro_proximity']

    # Stronger power features for area (area is critical)
    df['area_sqrt'] = np.sqrt(df['area'])
    df['area_cubed_norm'] = (df['area'] / df['area'].max()) ** 3  # normalized to 0-1 range
    features += ['area_sqrt', 'area_cubed_norm']

    # Composite location score (closer to both center AND metro = premium)
    df['location_score'] = (df['center_dist_inv'] + df['metro_dist_inv']) / 2.0
    df['location_score_sq'] = df['location_score'] ** 2
    features += ['location_score', 'location_score_sq']

    # ensure optional text/keyword columns
    for col in ['text','title_len','desc_len','has_word_remont','has_word_mebel','has_word_novostroi']:
        if col not in df.columns:
            df[col] = '' if col == 'text' else 0
    
    # Fill NaN values in text columns
    df['text'] = df['text'].fillna('')
    df['title_len'] = df['title_len'].fillna(0)
    df['desc_len'] = df['desc_len'].fillna(0)

    # smoothed district encoding
    global_mean = df['price'].mean()
    district_counts = df.groupby('district')['price'].transform('count')
    district_means = df.groupby('district')['price'].transform('mean')
    smooth_m = 5
    df['district_te'] = (district_counts * district_means + smooth_m * global_mean) / (district_counts + smooth_m)

    # Ensure all required columns exist before creating X
    all_cols_needed = features + ['text','title_len','desc_len','has_word_remont','has_word_mebel','has_word_novostroi','district_te']
    missing_cols = [c for c in all_cols_needed if c not in df.columns]
    if missing_cols:
        print(f"[WARN] Missing columns: {missing_cols}")
        # Add missing columns with default values
        for col in missing_cols:
            if col in ['text','title_len','desc_len']:
                df[col] = '' if col == 'text' else 0
            elif col in ['has_word_remont','has_word_mebel','has_word_novostroi']:
                df[col] = 0
            else:
                df[col] = 0  # default numeric

    X = df[all_cols_needed].copy()

    y = df['price'].copy()

    if use_log:
        y = np.log1p(y)

    # preprocessing
    numeric_features = ['area','rooms','floor','floors_total','metro_distance_min','latitude','longitude','center_distance_km','center_dist_sq','center_dist_log','center_dist_inv','metro_dist_sq','metro_dist_log','metro_dist_inv','area_x_center_inv','area_x_metro_inv','center_metro_proximity','area_sqrt','area_cubed_norm','location_score','location_score_sq','build_year','amenities_count','is_summer','is_winter','avg_rating','reviews_count','bookings_last_year','avg_booking_length','bookings_last_30','views_count','median_price_district','days_since_created','price_per_sqm','floor_ratio','title_len','desc_len','has_word_remont','has_word_mebel','has_word_novostroi','district_te']
    numeric_transform = Pipeline(steps=[('imputer', SimpleImputer(strategy='median')), ('scaler', StandardScaler())])
    cat_features = ['district','renovation_quality','furniture','month']
    cat_transform = Pipeline(steps=[('imputer', SimpleImputer(strategy='constant', fill_value='')), ('ohe', OneHotEncoder(handle_unknown='ignore'))])
    tfidf = TfidfVectorizer(max_features=300, ngram_range=(1,2), stop_words=None)
    preproc = ColumnTransformer(transformers=[('num', numeric_transform, numeric_features), ('cat', cat_transform, cat_features), ('tfidf', tfidf, 'text')])

    def build_pipe(model):
        return Pipeline(steps=[('pre', preproc), ('model', model)])

    base_model = GradientBoostingRegressor(n_estimators=500, learning_rate=0.05, max_depth=6, random_state=random_state, verbose=0)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=test_size, random_state=random_state)

    best_params = None
    cv_mae = None

    if tune:
        # RandomizedSearchCV tuning (keep it short and stable)
        param_distributions = {
            'model__learning_rate': stats.uniform(0.01, 0.15),
            'model__max_depth': [4,5,6,7,8],
            'model__min_samples_split': stats.randint(2,20),
            'model__subsample': stats.uniform(0.6,0.4),
            'model__n_estimators': stats.randint(200,800)
        }
        rs = RandomizedSearchCV(build_pipe(base_model), param_distributions=param_distributions, n_iter=max(3, min(n_iter, 40)), cv=3, scoring='neg_mean_absolute_error', random_state=random_state, n_jobs=1, verbose=1)
        print("\n[INFO] Starting RandomizedSearchCV tuning...")
        rs.fit(X_train, y_train)
        print(f"[INFO] Best params: {rs.best_params_}")
        pipe = rs.best_estimator_
        best_params = rs.best_params_
        cv_mae = -float(rs.best_score_)
    else:
        print("\n[INFO] Training without tuning...")
        pipe = build_pipe(base_model)
        scores = cross_val_score(pipe, X_train, y_train, cv=3, scoring='neg_mean_absolute_error', n_jobs=1)
        cv_mae = -float(np.mean(scores))
        print(f"[INFO] CV MAE: {cv_mae:.2f}")
        pipe.fit(X_train, y_train)

    y_pred = pipe.predict(X_test)
    if use_log:
        y_test_inv = np.expm1(y_test)
        y_pred_inv = np.expm1(y_pred)
    else:
        y_test_inv = y_test
        y_pred_inv = y_pred

    mae_holdout = float(mean_absolute_error(y_test_inv, y_pred_inv))
    rmse_holdout = float(math.sqrt(mean_squared_error(y_test_inv, y_pred_inv)))
    r2_holdout = float(r2_score(y_test_inv, y_pred_inv))

    try:
        perm = permutation_importance(pipe, X_test, y_test, n_repeats=8, random_state=random_state, n_jobs=1)
        try:
            cat_ohe = preproc.named_transformers_['cat'].named_steps['ohe']
            cat_names = list(cat_ohe.get_feature_names_out(cat_features))
            feature_names = numeric_features + cat_names
            imp_sorted_idx = perm.importances_mean.argsort()[::-1]
            importances = [{ 'feature': feature_names[i], 'importance': float(perm.importances_mean[i]) } for i in imp_sorted_idx if i < len(feature_names)]
        except Exception:
            importances = []
    except Exception:
        importances = []

    joblib.dump(pipe, PIPE_PATH)
    train_info = {
        'n_train': int(len(X_train)),
        'n_total': int(len(X)),
        'cv_mae': cv_mae,
        'mae_holdout': mae_holdout,
        'rmse_holdout': rmse_holdout,
        'r2_holdout': r2_holdout,
        'best_params': best_params,
        'use_log': bool(use_log),
        'importances_top5': importances[:10]
    }
    with open(os.path.join(os.path.dirname(__file__), 'train_info.json'), 'w', encoding='utf-8') as f:
        json.dump(train_info, f, ensure_ascii=False, indent=2)

    return {'status':'trained','mae_cv':cv_mae,'mae_holdout':mae_holdout,'r2_holdout':r2_holdout,'best_params':best_params}

    # save pipeline and training info
    joblib.dump(pipe, PIPE_PATH)
    train_info = {
        'n_train': int(len(X_train)),
        'n_total': int(len(X)),
        'cv_mae': cv_mae,
        'mae_holdout': mae_holdout,
        'rmse_holdout': rmse_holdout,
        'r2_holdout': r2_holdout,
        'best_params': best_params,
        'use_log': bool(use_log),
        'importances_top5': importances[:10],
        'tune_method': tune_method,
        'ensemble': bool(ensemble),
        'n_trials': int(n_iter)
    }
    with open(os.path.join(os.path.dirname(__file__), 'train_info.json'), 'w', encoding='utf-8') as f:
        json.dump(train_info, f, ensure_ascii=False, indent=2)

    return {'status':'trained','mae_cv':cv_mae,'mae_holdout':mae_holdout,'r2_holdout':r2_holdout,'best_params':best_params,'tune_method':tune_method,'ensemble':ensemble}



def load_pipeline():
    try:
        return joblib.load(PIPE_PATH)
    except Exception:
        return None


def load_training_info():
    """Load training metadata to check if model uses log transform."""
    try:
        info_path = os.path.join(os.path.dirname(__file__), 'train_info.json')
        with open(info_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'use_log': False}



def predict_get(listing_id: int = None):
    pipe = load_pipeline()
    if pipe is None:
        raise HTTPException(status_code=503, detail='model_not_trained')
    if listing_id is None:
        raise HTTPException(status_code=400, detail='provide listing_id or POST JSON')
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT id, price, rooms, housing_type, district, lat, lng, amenities FROM listings WHERE id = %s", (listing_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='listing not found')
        _, price, rooms, housing_type, district, lat, lng, amenities = row
        # build base feature dict
        base = {}
        synth = load_synthetic(or_generate=False)
        stats = compute_synth_stats(synth)
        base['area'] = float(stats['area_median'])
        base['rooms'] = int(rooms) if rooms else int(stats['rooms_mode'])
        base['floor'] = int(np.clip(np.random.randint(1, max(2,int(stats['floors_total_mean'])+1)),1,50))
        base['floors_total'] = int(max(2, int(stats['floors_total_mean'])))
        base['district'] = district if district else ''
        base['metro_distance_min'] = float(stats['metro_distance_mean'])
        base['renovation_quality'] = 'косметический'
        base['furniture'] = 'частично'
        base['latitude'] = float(lat) if lat else float(stats['latitude_mean'])
        base['longitude'] = float(lng) if lng else float(stats['longitude_mean'])
        base['center_distance_km'] = float(stats['center_distance_mean'])
        base['build_year'] = int(stats['build_year_median'])
        if amenities:
            ams = [x.strip() for x in amenities.split(',') if x.strip()]
            base['amenities_count'] = len(ams)
        else:
            base['amenities_count'] = int(stats['amenities_count_mean'])
        # predict per season representative months
        rep_month = {'winter':1,'spring':4,'summer':7,'autumn':10}
        seasons = {}
        for s, m in rep_month.items():
            feat = base.copy(); feat['month']=m
            feat['is_summer'] = 1 if m in [6,7,8] else 0
            feat['is_winter'] = 1 if m in [12,1,2] else 0
            Xpred = pd.DataFrame([feat])
            pred = pipe.predict(Xpred)[0]
            seasons[s] = int(round(float(pred)))
        # recommended = for current season
        current = month_to_season(datetime.utcnow().month)
        recommended = seasons.get(current, int(round(np.median(list(seasons.values())))))
        return {'base_price': int(round(price)) if price else None, 'seasons':seasons, 'recommended':recommended}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def median(a):
    a = sorted(a)
    n = len(a)
    if n == 0:
        return 0
    mid = n // 2
    if n % 2 == 1:
        return a[mid]
    else:
        return 0.5 * (a[mid - 1] + a[mid])


def current_season():
    return month_to_season(datetime.utcnow().month)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get('PRICE_SERVICE_PORT', 8000)))


@app.get("/predict")
def predict_get(listing_id: int = None):
    if listing_id is None:
        raise HTTPException(status_code=400, detail="Provide listing_id or POST body with features")
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT price, district, housing_type, title, description FROM listings WHERE id = %s", (listing_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing not found")
        price, district, housing_type, title, description = row
        
        # Load model
        pipe = load_pipeline()
        if pipe is None:
            return predict_from_features(price or 50000, district or "", housing_type or "")
        
        # Use full prediction pipeline with DB data
        synth = load_synthetic(or_generate=False)
        synth_stats = compute_synth_stats(synth)
        
        # Simulate POST request data structure
        data = {
            'price': price or 50000,
            'district': district or '',
            'housing_type': housing_type or '',
            'title': title or '',
            'description': description or '',
            'listing_id': listing_id
        }
        
        try:
            base = {}
            # Load DB data for this listing
            cur.execute("SELECT rooms, lat, lng, amenities, address FROM listings WHERE id = %s", (listing_id,))
            listing_row = cur.fetchone()
            if listing_row:
                rooms, lat, lng, amenities, address = listing_row
                base['rooms'] = int(rooms) if rooms else int(synth_stats['rooms_mode'])
                base['latitude'] = float(lat) if lat else float(synth_stats['latitude_mean'])
                base['longitude'] = float(lng) if lng else float(synth_stats['longitude_mean'])
                base['amenities_count'] = len([x.strip() for x in (amenities or '').split(',') if x.strip()]) if amenities else int(synth_stats['amenities_count_mean'])
            else:
                base['rooms'] = int(synth_stats['rooms_mode'])
                base['latitude'] = float(synth_stats['latitude_mean'])
                base['longitude'] = float(synth_stats['longitude_mean'])
                base['amenities_count'] = int(synth_stats['amenities_count_mean'])
            
            base['area'] = float(data.get('area', synth_stats['area_median']))
            base['floor'] = int(np.clip(np.random.randint(1, max(2, int(synth_stats['floors_total_mean'])+1)),1,50))
            base['floors_total'] = int(max(2, int(synth_stats['floors_total_mean'])))
            base['district'] = data.get('district', "")
            base['metro_distance_min'] = int(synth_stats.get('metro_distance_median', 300))
            base['renovation_quality'] = 'косметический'
            base['furniture'] = 'частично'
            base['center_distance_km'] = float(synth_stats['center_distance_mean'])
            base['build_year'] = int(synth_stats['build_year_median'])
            
            # Load DB-derived features from DB
            cur.execute("SELECT AVG(rating), COUNT(*) FROM reviews WHERE listing_id = %s", (listing_id,))
            rev = cur.fetchone()
            base['avg_rating'] = float(rev[0]) if rev[0] else 4.5
            base['reviews_count'] = int(rev[1]) if rev[1] else 0
            
            cur.execute("SELECT COUNT(*), AVG((end_date - start_date)::numeric) FROM bookings WHERE listing_id = %s AND status = 'approved' AND start_date >= (current_date - interval '365 days')", (listing_id,))
            bk = cur.fetchone()
            base['bookings_last_year'] = int(bk[0]) if bk[0] else 0
            base['avg_booking_length'] = int(bk[1]) if bk[1] else 10
            
            cur.execute("SELECT COUNT(*) FROM bookings WHERE listing_id = %s AND status = 'approved' AND start_date >= (current_date - interval '30 days')", (listing_id,))
            bk30 = cur.fetchone()
            base['bookings_last_30'] = int(bk30[0]) if bk30[0] else 0
            
            cur.execute("SELECT COUNT(*) FROM listing_views WHERE listing_id = %s", (listing_id,))
            views = cur.fetchone()
            base['views_count'] = int(views[0]) if views[0] else 0
            
            cur.execute("SELECT created_at FROM listings WHERE id = %s", (listing_id,))
            created = cur.fetchone()
            if created and created[0]:
                if isinstance(created[0], datetime):
                    created_date = created[0].date()
                elif isinstance(created[0], date):
                    created_date = created[0]
                else:
                    created_date = date.today()
                days_since = (date.today() - created_date).days
                base['days_since_created'] = max(1, int(days_since))
            else:
                base['days_since_created'] = 1
            
            conn.close()
            
            base['median_price_district'] = float(synth_stats.get('median_price_district_median', price or 50000))
            base['price_per_sqm'] = float(price or 50000) / base['area'] if base['area'] > 0 else float(price or 50000)
            base['floor_ratio'] = float(base['floor']) / base['floors_total'] if base['floors_total'] > 0 else 0.5
            
            # Text features
            title = data.get('title', '')
            desc = data.get('description', '')
            base['title_len'] = len(title)
            base['desc_len'] = len(desc)
            base['has_word_remont'] = 1 if 'ремонт' in desc.lower() else 0
            base['has_word_mebel'] = 1 if 'мебель' in desc.lower() or 'меблированн' in desc.lower() else 0
            base['has_word_novostroi'] = 1 if 'новостройка' in desc.lower() or 'новое' in desc.lower() else 0
            
            # Key features engineering
            base['metro_distance_km'] = base['metro_distance_min'] / 1000.0
            base['center_dist_sq'] = base['center_distance_km'] ** 2
            base['center_dist_log'] = np.log1p(base['center_distance_km'])
            base['center_dist_inv'] = 1.0 / (1.0 + base['center_distance_km'])
            
            base['metro_dist_sq'] = base['metro_distance_km'] ** 2
            base['metro_dist_log'] = np.log1p(base['metro_distance_km'])
            base['metro_dist_inv'] = 1.0 / (1.0 + base['metro_distance_km'])
            
            base['area_x_center_inv'] = base['area'] * base['center_dist_inv']
            base['area_x_metro_inv'] = base['area'] * base['metro_dist_inv']
            base['center_metro_proximity'] = base['center_dist_inv'] * base['metro_dist_inv']
            
            base['area_sqrt'] = np.sqrt(base['area'])
            base['area_cubed_norm'] = ((base['area'] / 100.0) ** 3) / 1000.0
            
            base['location_score'] = (base['center_dist_inv'] + base['metro_dist_inv']) / 2.0
            base['location_score_sq'] = base['location_score'] ** 2
            
            base['district_te'] = base['median_price_district']
            base['text'] = (title + ' ' + desc).lower()
            
            # Load training info
            train_info = load_training_info()
            use_log = train_info.get('use_log', False)
            
            # Predict per season
            rep_month = {'winter':1,'spring':4,'summer':7,'autumn':10}
            seasons = {}
            for s, m in rep_month.items():
                feat = base.copy()
                feat['month'] = m
                feat['is_summer'] = 1 if m in [6,7,8] else 0
                feat['is_winter'] = 1 if m in [12,1,2] else 0
                Xpred = pd.DataFrame([feat])
                pred = pipe.predict(Xpred)[0]
                if use_log:
                    pred = np.expm1(pred)
                seasons[s] = int(round(float(pred)))
            
            current = month_to_season(datetime.utcnow().month)
            recommended = seasons.get(current, int(round(np.median(list(seasons.values())))))
            return {'base_price': int(round(float(price or 50000))), 'seasons':seasons, 'recommended':recommended}
            
        except Exception as e:
            import traceback
            print(f"[ERROR] GET Predict with DB data failed: {e}")
            print(traceback.format_exc())
            return predict_from_features(price or 50000, district or "", housing_type or "")
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/predict")
async def predict_post(req: Request):
    data = await req.json()
    price = data.get('price')
    district = data.get('district', "") or ""
    housing_type = data.get('housing_type', "") or ""
    listing_id = data.get('listing_id')  # optional: if editing existing listing
    
    if price is None:
        raise HTTPException(status_code=400, detail="price is required")
    
    # Prefer the trained pipeline when available for more realistic seasonal estimates
    pipe = load_pipeline()
    if pipe is None:
        return predict_from_features(price, district, housing_type)
    
    try:
        synth = load_synthetic(or_generate=False)
        synth_stats = compute_synth_stats(synth)
        
        # If editing existing listing, load its current data from DB as base
        db_data = {}
        if listing_id:
            try:
                conn = get_conn()
                cur = conn.cursor()
                cur.execute("SELECT rooms, housing_type, district, title, description FROM listings WHERE id = %s", (listing_id,))
                row = cur.fetchone()
                if row:
                    db_data = {
                        'rooms': row[0],
                        'housing_type': row[1],
                        'district': row[2],
                        'title': row[3],
                        'description': row[4]
                    }
                conn.close()
            except Exception as e:
                print(f"[WARN] Could not load listing {listing_id}: {e}")
        
        base = {}
        # Merge: prefer data from request, fall back to DB data, then synth stats
        base['area'] = float(data.get('area', db_data.get('area', synth_stats['area_median'])))
        base['rooms'] = int(data.get('rooms', db_data.get('rooms', synth_stats['rooms_mode'])))
        base['floor'] = int(data.get('floor', np.clip(np.random.randint(1, max(2, int(synth_stats['floors_total_mean'])+1)),1,50)))
        base['floors_total'] = int(data.get('floors_total', max(2, int(synth_stats['floors_total_mean']))))
        base['district'] = data.get('district', db_data.get('district', ""))
        base['metro_distance_min'] = float(data.get('metro_distance_min', synth_stats['metro_distance_mean']))
        base['renovation_quality'] = data.get('renovation_quality', 'косметический')
        base['furniture'] = data.get('furniture', 'частично')
        base['latitude'] = float(data.get('latitude', synth_stats['latitude_mean']))
        base['longitude'] = float(data.get('longitude', synth_stats['longitude_mean']))
        base['center_distance_km'] = float(data.get('center_distance_km', synth_stats['center_distance_mean']))
        base['build_year'] = int(data.get('build_year', synth_stats['build_year_median']))
        base['amenities_count'] = int(data.get('amenities_count', synth_stats['amenities_count_mean']))
        
        # For DB-derived features (rating, reviews, bookings): if editing, load from DB
        if listing_id:
            try:
                conn = get_conn()
                cur = conn.cursor()
                # reviews
                cur.execute("SELECT AVG(rating), COUNT(*) FROM reviews WHERE listing_id = %s", (listing_id,))
                rev = cur.fetchone()
                base['avg_rating'] = float(rev[0]) if rev[0] else 4.5
                base['reviews_count'] = int(rev[1]) if rev[1] else 0
                # bookings last year
                cur.execute("SELECT COUNT(*), AVG(EXTRACT(DAY FROM (end_date - start_date))) FROM bookings WHERE listing_id = %s AND status = 'approved' AND start_date >= (current_date - interval '365 days')", (listing_id,))
                bk = cur.fetchone()
                base['bookings_last_year'] = int(bk[0]) if bk[0] else 0
                base['avg_booking_length'] = int(bk[1]) if bk[1] else 10
                # bookings last 30 days
                cur.execute("SELECT COUNT(*) FROM bookings WHERE listing_id = %s AND status = 'approved' AND start_date >= (current_date - interval '30 days')", (listing_id,))
                bk30 = cur.fetchone()
                base['bookings_last_30'] = int(bk30[0]) if bk30[0] else 0
                # views
                cur.execute("SELECT COUNT(*) FROM listing_views WHERE listing_id = %s", (listing_id,))
                views = cur.fetchone()
                base['views_count'] = int(views[0]) if views[0] else 0
                # created_at
                cur.execute("SELECT created_at FROM listings WHERE id = %s", (listing_id,))
                created = cur.fetchone()
                if created and created[0]:
                    if isinstance(created[0], datetime):
                        created_date = created[0].date()
                    elif isinstance(created[0], date):
                        created_date = created[0]
                    else:
                        created_date = date.today()
                    days_since = (date.today() - created_date).days
                    base['days_since_created'] = max(1, int(days_since))
                else:
                    base['days_since_created'] = 1
                    base['days_since_created'] = 1
                conn.close()
            except Exception as e:
                print(f"[WARN] Could not load DB features for listing {listing_id}: {e}")
                # use defaults
                base['avg_rating'] = float(data.get('avg_rating', synth_stats.get('avg_rating_median', 4.5)))
                base['reviews_count'] = int(data.get('reviews_count', synth_stats.get('reviews_count_median', 0)))
                base['bookings_last_year'] = int(data.get('bookings_last_year', synth_stats.get('bookings_last_year_median', 5)))
                base['avg_booking_length'] = float(data.get('avg_booking_length', synth_stats.get('avg_booking_length_median', 10)))
                base['bookings_last_30'] = int(data.get('bookings_last_30', synth_stats.get('bookings_last_30_median', 1)))
                base['views_count'] = int(data.get('views_count', synth_stats.get('views_count_median', 30)))
                base['days_since_created'] = int(data.get('days_since_created', 1))
        else:
            # new listing: use defaults
            base['avg_rating'] = float(data.get('avg_rating', synth_stats.get('avg_rating_median', 4.5)))
            base['reviews_count'] = int(data.get('reviews_count', synth_stats.get('reviews_count_median', 0)))
            base['bookings_last_year'] = int(data.get('bookings_last_year', synth_stats.get('bookings_last_year_median', 5)))
            base['avg_booking_length'] = float(data.get('avg_booking_length', synth_stats.get('avg_booking_length_median', 10)))
            base['bookings_last_30'] = int(data.get('bookings_last_30', synth_stats.get('bookings_last_30_median', 1)))
            base['views_count'] = int(data.get('views_count', synth_stats.get('views_count_median', 30)))
            base['days_since_created'] = int(data.get('days_since_created', 1))
        
        base['median_price_district'] = float(data.get('median_price_district', synth_stats.get('median_price_district_median', price)))
        base['price_per_sqm'] = float(price) / base['area'] if base['area'] > 0 else float(price)
        base['floor_ratio'] = float(base['floor']) / base['floors_total'] if base['floors_total'] > 0 else 0.5
        
        # Text features based on description
        title = data.get('title', '')
        desc = data.get('description', '')
        base['title_len'] = len(title)
        base['desc_len'] = len(desc)
        base['has_word_remont'] = 1 if 'ремонт' in desc.lower() else 0
        base['has_word_mebel'] = 1 if 'мебель' in desc.lower() or 'меблированн' in desc.lower() else 0
        base['has_word_novostroi'] = 1 if 'новостройка' in desc.lower() or 'новое' in desc.lower() else 0
        
        # ===== KEY FEATURES ENGINEERING =====
        # Convert metro distance to km for consistency
        base['metro_distance_km'] = base['metro_distance_min'] / 1000.0
        
        # Polynomial features for center distance
        base['center_dist_sq'] = base['center_distance_km'] ** 2
        base['center_dist_log'] = np.log1p(base['center_distance_km'])
        base['center_dist_inv'] = 1.0 / (1.0 + base['center_distance_km'])
        
        # Polynomial features for metro distance
        base['metro_dist_sq'] = base['metro_distance_km'] ** 2
        base['metro_dist_log'] = np.log1p(base['metro_distance_km'])
        base['metro_dist_inv'] = 1.0 / (1.0 + base['metro_distance_km'])
        
        # KEY INTERACTIONS: boost area + location importance
        base['area_x_center_inv'] = base['area'] * base['center_dist_inv']
        base['area_x_metro_inv'] = base['area'] * base['metro_dist_inv']
        base['center_metro_proximity'] = base['center_dist_inv'] * base['metro_dist_inv']
        
        # Stronger power features for area
        base['area_sqrt'] = np.sqrt(base['area'])
        base['area_cubed_norm'] = ((base['area'] / 100.0) ** 3) / 1000.0  # normalized power
        
        # Composite location score (closer to both center AND metro = premium)
        base['location_score'] = (base['center_dist_inv'] + base['metro_dist_inv']) / 2.0
        base['location_score_sq'] = base['location_score'] ** 2
        
        # Target encoding for district (simplified: use median price as proxy)
        base['district_te'] = base['median_price_district']
        
        # Add 'text' field for TF-IDF (combines title and description)
        base['text'] = (title + ' ' + desc).lower()
        
        # Load training info to check if model uses log transform
        train_info = load_training_info()
        use_log = train_info.get('use_log', False)
        
        # predict per season representative months
        rep_month = {'winter':1,'spring':4,'summer':7,'autumn':10}
        seasons = {}
        for s, m in rep_month.items():
            feat = base.copy()
            feat['month'] = m
            feat['is_summer'] = 1 if m in [6,7,8] else 0
            feat['is_winter'] = 1 if m in [12,1,2] else 0
            Xpred = pd.DataFrame([feat])
            pred = pipe.predict(Xpred)[0]
            # Apply inverse log transform if model was trained with log
            if use_log:
                pred = np.expm1(pred)
            seasons[s] = int(round(float(pred)))
        current = month_to_season(datetime.utcnow().month)
        recommended = seasons.get(current, int(round(np.median(list(seasons.values())))))
        return {'base_price': int(round(float(price))), 'seasons':seasons, 'recommended':recommended}
    except Exception as e:
        # fallback to simple multiplier-based predictor
        print(f"[ERROR] Predict failed: {e}")
        import traceback
        traceback.print_exc()
        return predict_from_features(price, district, housing_type)


def predict_from_features(price, district, housing_type):
    multipliers = load_multipliers()
    base = float(price)
    seasons = {}
    # try group-specific
    key = f"{district}|{housing_type}"
    gm = multipliers.get('groups', {}).get(key)
    if gm:
        for s, mult in gm.items():
            seasons[s] = int(round(base * float(mult)))
    else:
        # try district-only
        key2 = f"{district}|"
        gm2 = multipliers.get('groups', {}).get(key2)
        if gm2:
            for s, mult in gm2.items():
                seasons[s] = int(round(base * float(mult)))
        else:
            # try housing-only
            key3 = f"|{housing_type}"
            gm3 = multipliers.get('groups', {}).get(key3)
            if gm3:
                for s, mult in gm3.items():
                    seasons[s] = int(round(base * float(mult)))
            else:
                # fallback global
                for s, mult in multipliers.get('global', {}).items():
                    seasons[s] = int(round(base * float(mult)))
    recommended = seasons.get(current_season(), list(seasons.values())[0] if seasons else int(base))
    return {"base_price": int(round(base)), "seasons": seasons, "recommended": int(round(recommended))}


def load_multipliers():
    try:
        with open(MULTIPLIERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        # default neutral multipliers
        return {'groups': {}, 'global': {s: 1.0 for s in SEASONS.keys()}, 'global_baseline': 1.0}


def median(a):
    a = sorted(a)
    n = len(a)
    if n == 0:
        return 0
    mid = n // 2
    if n % 2 == 1:
        return a[mid]
    else:
        return 0.5 * (a[mid - 1] + a[mid])


def current_season():
    return month_to_season(datetime.utcnow().month)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get('PRICE_SERVICE_PORT', 8000)))
