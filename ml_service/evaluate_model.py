import sys, joblib, os, psycopg2, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from sklearn.metrics import mean_absolute_error
from main import get_conn, load_pipeline, compute_synth_stats, load_synthetic

PIPE_PATH = os.path.join(os.path.dirname(__file__), 'pipeline.joblib')
pipe = load_pipeline()
if pipe is None:
    print('no pipeline')
    raise SystemExit(1)
conn = get_conn()
cur = conn.cursor()
cur.execute("SELECT id, price, rooms, housing_type, district, lat, lng, amenities, title, description FROM listings WHERE price IS NOT NULL")
rows = cur.fetchall()
synth = load_synthetic(or_generate=False)
stats = compute_synth_stats(synth)

# use assemble_db_df to create features consistent with training pipeline
from main import assemble_db_df
synth = load_synthetic(or_generate=False)
stats = compute_synth_stats(synth)
db_df2 = assemble_db_df(conn, synth_stats=stats)
db_df2 = db_df2[~db_df2['price'].isnull()]
ids = list(db_df2['price'].index) if hasattr(db_df2['price'], 'index') else list(range(len(db_df2)))
actuals = list(db_df2['price'].astype(float))
X = db_df2.copy()
# diagnostics
print('area: min, median, mean', X['area'].min(), X['area'].median(), X['area'].mean())
print('price_per_sqm: min, median, mean', X['price_per_sqm'].min(), X['price_per_sqm'].median(), X['price_per_sqm'].mean())
# ensure columns expected by preproc exist
for col in ['text','title_len','desc_len','has_word_remont','has_word_mebel','has_word_novostroi']:
    if col not in X.columns:
        X[col] = '' if col == 'text' else 0
preds = pipe.predict(X)
print('preds: min, median, mean', float(np.min(preds)), float(np.median(preds)), float(np.mean(preds)))

mae = mean_absolute_error(actuals, preds)
print('MAE full dataset:', mae)
print('MAE relative to mean price:', mae / np.mean(actuals))

# filter unrealistic prices (too large or too small) for a more meaningful MAE
filtered = [(i,a,p) for i,a,p in zip(ids, actuals, preds) if 50 < a < 500000]
if filtered:
    fa = [a for _,a,_ in filtered]
    fp = [p for _,_,p in filtered]
    fmae = mean_absolute_error(fa, fp)
    print('MAE filtered (50..500k):', fmae, 'relative:', fmae/np.mean(fa))

errs = [{'id':i, 'actual':a, 'pred':int(round(p)), 'abs_err':abs(a-p)} for i,a,p in zip(ids, actuals, preds)]
errs_sorted = sorted(errs, key=lambda x: -x['abs_err'])
for e in errs_sorted[:10]:
    print(e)
