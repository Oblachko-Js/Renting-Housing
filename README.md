# Renting Housing

Проект представляет собой сервис аренды жилья с веб-интерфейсом на Node.js/Express и ML-сервисом на Python/FastAPI для прогнозирования цен.

## Структура проекта

- `app.js` — основной сервер Express, рендеринг страниц `views/*.html`, маршруты для регистрации, аутентификации, объявлений, бронирований, чатов, избранного и админки.
- `views/` — HTML-шаблоны EJS для интерфейса пользователя.
- `public/` — статические файлы: CSS, JS, изображения.
- `ml_service/` — Python-сервис прогнозирования цен.
  - `main.py` — FastAPI приложение, которое предоставляет `/health`, `/predict` и `/train_model`.
  - `spb_rent_realistic.csv` — синтетический датасет для обучения/заполнения признаков.
  - `pipeline.joblib`, `model.joblib` — сериализованные модели/пайплайны.
  - `requirements.txt` — Python зависимости.
- `package.json` — зависимости Node.js.
- `catboost_info/` — информация обучения CatBoost и артефакты тренировки.

## Функциональные возможности

- Публикация и редактирование объявлений аренды.
- Просмотр объявлений с фото, описанием, ценой, адресом и рейтингом.
- Фильтрация и поиск списка объявлений.
- Интеграция с картой (Яндекс.Карты) и отображение знаков объявлений.
- Личные профили для арендаторов и владельцев.
- Система избранного и отзывы.
- Система бронирования с проверкой пересечений заявок.
- Админская панель для просмотра таблиц базы данных.
- Прогноз цены через ML-сервис.

## Архитектура

1. Веб-приложение на `app.js` работает как основная платформа.
2. Оно подключается к PostgreSQL через `pg`.
3. Для расчёта цен приложение вызывает Python-сервис `ml_service`:
   - `POST /api/recommend_price` делает запрос `/predict` к FastAPI.
   - Если ML-сервис недоступен, приложение обрабатывает ошибку и возвращает `price_service_unreachable`.
4. ML-сервис загружает синтетические данные и обученную модель, или fallback на простые множители.

## Требования

### PostgreSQL

Требуется база данных PostgreSQL. В проекте используются таблицы:
- `users`
- `listings`
- `bookings`
- `reviews`
- `listing_views`
- `favorites`
- `messages`

Точные схемы можно восстановить из приложения: `app.js` создаёт дополнительные колонки `listings` при необходимости.

### Node.js

- `node` 18+ / 20+
- `npm`

### Python

- Python 3.11+ (или совместимая версия)
- `pip`

## Установка

### 1. Установите зависимости Node.js

```bash
cd /Users/andrey/Documents/Diploma/gotovayaproga(razykrasit)/Renting-Housing
npm install
```

### 2. Установите Python зависимости для ML-сервиса

```bash
cd ml_service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Настройка окружения

По умолчанию приложение использует следующие значения:

- PostgreSQL: `user=andrey`, `host=localhost`, `database=myprogram`, `port=5432`
- Python ML-сервис: `PRICE_SERVICE_HOST=127.0.0.1`, `PRICE_SERVICE_PORT=8000`

Если нужно, задайте переменные окружения:

```bash
export PG_USER=andrey
export PG_PASSWORD=
export PG_HOST=localhost
export PG_PORT=5432
export PG_DB=myprogram
export PRICE_SERVICE_HOST=127.0.0.1
export PRICE_SERVICE_PORT=8000
```

Для отправки почты (опционально):

```bash
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_USER=youruser
export SMTP_PASS=yourpass
export SMTP_FROM=from@example.com
```

## Запуск

### 1. Запустить ML-сервис

```bash
cd ml_service
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000
```

Или из каталога `ml_service`:

```bash
python main.py
```

### 2. Запустить веб-приложение

```bash
cd /Users/andrey/Documents/Diploma/gotovayaproga(razykrasit)/Renting-Housing
node app.js
```

По умолчанию лучше открыть `http://localhost:3000` или порт, который указан в коде. Если порт не задан явно, приложение стартует на стандартном порту Node.js, проверяйте запуск в логах.

## Как пользоваться

- Перейдите на `/` для просмотра списка объявлений.
- Зарегистрируйтесь как `landlord` или `tenant`.
- Создайте объявление на `/listings/new`.
- Перейдите в объявление и посмотрите прогноз цены, сезонные рекомендации, карту и аналитику.
- Проверьте бронирования и чаты в профиле.

## ML-сервис и прогноз цен

ML-сервис находится в `ml_service/main.py`.

### Основные маршруты

- `GET /health` — проверка работоспособности.
- `GET /predict?listing_id=<id>` — прогноз цены для существующего объявления.
- `POST /predict` — прогноз по данным объявления.
- `POST /train_model` — запуск тренировки модели на синтетическом и реальном наборе.

### Синтетические данные

Сервис использует `ml_service/spb_rent_realistic.csv`. Если файл не найден, он может генерировать датасет автоматически через `generate_synthetic.py`.

### Fallback

Если модель недоступна или предсказание не прошло, `main.py` переходит на простую детерминистическую стратегию с множителями (`load_multipliers()`), загружая JSON-файл множителей.

## Полезные файлы

- `package.json` — зависимости Node.js.
- `ml_service/requirements.txt` — Python зависимости.
- `views/` — шаблоны интерфейса.
- `public/css/style.css` — стили.
- `public/js/main.js` — клиентский JS.
- `ml_service/pipeline.joblib` и `ml_service/model.joblib` — обученная модель и пайплайн.
- `ml_service/generate_synthetic.py` — генерация синтетических данных.

## Примечания

- В проекте используется PostgreSQL. Перед запуском убедитесь, что база данных доступна и содержит таблицы `users`, `listings`, `bookings`, `reviews` и т.д.
- В `app.js` реализован административный доступ через backdoor `admin/admin`.
- Визуальная часть приложения генерируется в `views/*.html` и использует EJS-шаблоны.

## Контакт и разработка

Этот `README` описывает базовую установку и запуск проекта. Для доработки можно:

- добавить `npm start` в `package.json`;
- вынести конфигурацию в `.env`;
- оформить запуск ML-сервиса через Docker или `docker-compose`.
