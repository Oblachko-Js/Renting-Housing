Инструкции по сервису прогнозов цен

1) Создать виртуальное окружение и установить зависимости:

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

2) Установить переменные окружения при необходимости (по умолчанию берутся значения как в `app.js`):

export PG_USER=andrey
export PG_PASSWORD=
export PG_HOST=localhost
export PG_PORT=5432
export PG_DB=myprogram

3) Запустить сервис:

uvicorn main:app --host 127.0.0.1 --port 8000

4) Сгенерировать / подготовить синтетические данные (если ещё не сделали):

python ml_service/generate_synthetic.py  # создаст spb_rent_realistic.csv

5) Обучить модель (используется синтетика + данные из БД). Запустите из shell или curl:

curl -X POST "http://127.0.0.1:8000/train_model" -d ""  # опционально передать параметр samples

6) Предсказать цену для объявления (использует обученную модель):

GET /predict?listing_id=123  — вернёт season-предсказания для объявления

Ответ: { base_price, seasons: { winter: .., spring: .., summer: .., autumn: .. }, recommended }
