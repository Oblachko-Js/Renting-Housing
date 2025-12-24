import joblib, os
PIPE_PATH = os.path.join(os.path.dirname(__file__), 'pipeline.joblib')
pipe = joblib.load(PIPE_PATH)
print(pipe)
try:
    pre = pipe.named_steps['pre']
    print('Preprocessor:', pre)
    print('Transformers:', pre.transformers)
except Exception as e:
    print('No preprocessor or error:', e)
