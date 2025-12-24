import os, joblib
from main import load_synthetic, compute_synth_stats, get_conn, assemble_db_df, CatBoostSklearnWrapper
import pandas as pd

synth = load_synthetic(or_generate=False)
stats = compute_synth_stats(synth)
conn = get_conn()
db_df = assemble_db_df(conn, synth_stats=stats)
db_df = db_df[~db_df['price'].isnull()]
df = pd.concat([synth, db_df], ignore_index=True, sort=False)
# create district_te
global_mean = df['price'].mean()
district_counts = df.groupby('district')['price'].transform('count')
district_means = df.groupby('district')['price'].transform('mean')
df['district_te'] = (district_counts * district_means + 5 * global_mean) / (district_counts + 5)

features = ['area','rooms','floor','floors_total','district','metro_distance_min','renovation_quality','furniture','month','latitude','longitude','center_distance_km','build_year','amenities_count','is_summer','is_winter','avg_rating','reviews_count','bookings_last_year','avg_booking_length','bookings_last_30','views_count','median_price_district','days_since_created','price_per_sqm','floor_ratio','title_len','desc_len','has_word_remont','has_word_mebel','has_word_novostroi','district_te']
# ensure columns exist
for col in features:
    if col not in df.columns:
        df[col] = 0
X = df[features].copy()
y = df['price'].copy()

# train CatBoost wrapper
cat_cols = ['district','renovation_quality','furniture','month']
wrapper = CatBoostSklearnWrapper(params={'iterations':800,'learning_rate':0.03,'depth':6,'loss_function':'MAE'}, cat_features=cat_cols, random_state=42)
wrapper.fit(X, y)

from sklearn.pipeline import Pipeline
pipe = Pipeline([('model', wrapper)])
# call pipeline.fit to mark it as fitted (it will call wrapper.fit again but that's inexpensive)
pipe.fit(X, y)
PATH = os.path.join(os.path.dirname(__file__), 'pipeline.joblib')
joblib.dump(pipe, PATH)
print('Saved pipeline to', PATH)
