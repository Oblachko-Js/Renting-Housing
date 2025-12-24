const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const { Pool } = require("pg");
const path = require("path");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const multer = require("multer");
const nodemailer = require("nodemailer");
let mailer;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function notifyUser(io, userId, payload) {
  io.to(`user_${userId}`).emit("notify", payload);
}

async function emailUser(userId, subject, text) {
  if (!mailer) return;
  try {
    const r = await pool.query("SELECT email FROM users WHERE id = $1", [
      userId,
    ]);
    const email = r.rows[0] && r.rows[0].email;
    if (!email) return;
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject,
      text,
    });
  } catch (_) {}
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка подключения к PostgreSQL
const pool = new Pool({
  user: "andrey", // замени на своего пользователя
  host: "localhost",
  database: "myprogram", // замени на свою БД
  password: "", // замени на свой пароль
  port: 5432,
});

// Ленивая инициализация дополнительных колонок в listings
let listingsColumnsEnsured = false;
async function ensureListingExtraColumns() {
  if (listingsColumnsEnsured) return;
  try {
    await pool.query(
      `ALTER TABLE listings
         ADD COLUMN IF NOT EXISTS rooms INTEGER,
         ADD COLUMN IF NOT EXISTS housing_type VARCHAR(20),
         ADD COLUMN IF NOT EXISTS district VARCHAR(100),
         ADD COLUMN IF NOT EXISTS amenities TEXT,
         ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
         ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
         ADD COLUMN IF NOT EXISTS photos TEXT`
    );
  } catch (_) {}
  listingsColumnsEnsured = true;
}

// Сессии
app.use(
  session({
    secret: "mysecret",
    resave: false,
    saveUninitialized: false,
  })
);

// Middleware для подсчёта непрочитанных сообщений (перемещён выше роутов)
app.use(async (req, res, next) => {
  if (req.session.userId) {
    const unread = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false AND text <> ''`,
      [req.session.userId]
    );
    res.locals.unreadCount = parseInt(unread.rows[0].count, 10);
  } else {
    res.locals.unreadCount = 0;
  }
  next();
});

// Парсинг форм
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// helper: простой http клиент для вызова Python сервиса прогнозов
function callPriceService(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: process.env.PRICE_SERVICE_HOST || "127.0.0.1",
      port: Number(process.env.PRICE_SERVICE_PORT || 8000),
      path: path,
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          return resolve(JSON.parse(data));
        } catch (e) {
          return resolve(null);
        }
      });
    });
    req.on("error", (e) => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// endpoint для клиента: оценить цену по атрибутам (в т.ч. для формы создания)
app.post("/api/recommend_price", async (req, res) => {
  try {
    const payload = req.body;
    const ans = await callPriceService("/predict", "POST", payload);
    res.json(ans || {});
  } catch (e) {
    res.status(500).json({ error: "price_service_unreachable" });
  }
});

// Папка для статики
app.use(express.static(path.join(__dirname, "public")));

// Папка для html
app.set("views", path.join(__dirname, "views"));
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");

const uploadDir = path.join(__dirname, "public", "images");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});
const upload = multer({ storage });
const uploadMultiple = multer({ storage }).array("photos", 10); // максимум 10 фото
const uploadFields = multer({ storage }).fields([
  { name: "photos", maxCount: 10 },
  { name: "additional_photos", maxCount: 10 },
]);

// Главная страница

// Ленивая инициализация таблицы истории просмотров объявлений (глобально)
let listingViewsTableEnsured = false;
async function ensureListingViewsTable() {
  if (listingViewsTableEnsured) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS listing_views (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        viewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ip INET,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_listing_views_listing ON listing_views(listing_id);
      CREATE INDEX IF NOT EXISTS idx_listing_views_viewer ON listing_views(viewer_id);
      CREATE INDEX IF NOT EXISTS idx_listing_views_created ON listing_views(created_at);
    `);
  } catch (_) {}
  listingViewsTableEnsured = true;
}
// API endpoint для загрузки объявлений с пагинацией
app.get("/api/listings", async (req, res) => {
  await ensureListingExtraColumns();
  let {
    q,
    min_price,
    max_price,
    rooms_min,
    rooms_max,
    housing_type,
    district,
    amenity,
    page = 1,
    limit = 3,
  } = req.query;

  page = parseInt(page);
  limit = parseInt(limit);
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(l.title ILIKE $${params.length} OR l.address ILIKE $${params.length})`
    );
  }
  if (min_price) {
    params.push(min_price);
    where.push(`l.price >= $${params.length}`);
  }
  if (max_price) {
    params.push(max_price);
    where.push(`l.price <= $${params.length}`);
  }
  if (rooms_min) {
    params.push(rooms_min);
    where.push(`l.rooms >= $${params.length}`);
  }
  if (rooms_max) {
    params.push(rooms_max);
    where.push(`l.rooms <= $${params.length}`);
  }
  if (housing_type) {
    params.push(housing_type);
    where.push(`l.housing_type = $${params.length}`);
  }
  if (district) {
    params.push(`%${district}%`);
    where.push(`l.district ILIKE $${params.length}`);
  }
  if (amenity) {
    // amenity может быть строкой или массивом
    const ams = Array.isArray(amenity) ? amenity : [amenity];
    for (const a of ams) {
      params.push(`%${a}%`);
      where.push(`l.amenities ILIKE $${params.length}`);
    }
  }

  let sql = `SELECT l.*, COALESCE(u.display_name, u.username) AS owner_username FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql +=
    " ORDER BY l.id DESC LIMIT $" +
    (params.length + 1) +
    " OFFSET $" +
    (params.length + 2);
  params.push(limit, offset);

  const listings = await pool.query(sql, params);

  // Получаем общее количество для проверки есть ли ещё страницы
  let countSql = `SELECT COUNT(*) FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    countSql += " WHERE " + where.join(" AND ");
  }
  const countParams = params.slice(0, -2); // убираем limit и offset
  const countResult = await pool.query(countSql, countParams);
  const totalCount = parseInt(countResult.rows[0].count);
  const hasMore = offset + limit < totalCount;

  res.json({
    listings: listings.rows,
    hasMore,
    currentPage: page,
    totalCount,
  });
});

app.get("/", async (req, res) => {
  await ensureListingExtraColumns();
  let {
    q,
    min_price,
    max_price,
    rooms_min,
    rooms_max,
    housing_type,
    district,
    amenity,
  } = req.query;

  // Для главной страницы загружаем только первые 3 объявления
  let where = [];
  let params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(l.title ILIKE $${params.length} OR l.address ILIKE $${params.length})`
    );
  }
  if (min_price) {
    params.push(min_price);
    where.push(`l.price >= $${params.length}`);
  }
  if (max_price) {
    params.push(max_price);
    where.push(`l.price <= $${params.length}`);
  }
  if (rooms_min) {
    params.push(rooms_min);
    where.push(`l.rooms >= $${params.length}`);
  }
  if (rooms_max) {
    params.push(rooms_max);
    where.push(`l.rooms <= $${params.length}`);
  }
  if (housing_type) {
    params.push(housing_type);
    where.push(`l.housing_type = $${params.length}`);
  }
  if (district) {
    params.push(`%${district}%`);
    where.push(`l.district ILIKE $${params.length}`);
  }
  if (amenity) {
    // amenity может быть строкой или массивом
    const ams = Array.isArray(amenity) ? amenity : [amenity];
    for (const a of ams) {
      params.push(`%${a}%`);
      where.push(`l.amenities ILIKE $${params.length}`);
    }
  }

  let sql = `SELECT l.*, COALESCE(u.display_name, u.username) AS owner_username FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql += " ORDER BY l.id DESC LIMIT 3";
  const listings = await pool.query(sql, params);

  // Получаем общее количество для проверки есть ли ещё объявления
  let countSql = `SELECT COUNT(*) FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    countSql += " WHERE " + where.join(" AND ");
  }
  const countResult = await pool.query(countSql, params);
  const totalCount = parseInt(countResult.rows[0].count);
  const hasMore = listings.rows.length < totalCount;

  // Для карты загружаем ВСЕ объявления (без LIMIT)
  let mapSql = `SELECT l.id, l.title, l.lat, l.lng, l.photo, l.price FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    mapSql += " WHERE " + where.join(" AND ");
  }
  mapSql += " ORDER BY l.id DESC";
  const allListings = await pool.query(mapSql, params);

  res.render("index", {
    listings: listings.rows,
    allListings: allListings.rows, // Все объявления для карты
    hasMore,
    totalCount,
    user: req.session.userId
      ? {
          id: req.session.userId,
          username: req.session.username,
          role: req.session.role,
        }
      : null,
    q,
    min_price,
    max_price,
    filters: {
      rooms_min,
      rooms_max,
      housing_type,
      district,
      amenity: amenity || [],
    },
    unreadCount: res.locals.unreadCount,
  });
});

// Страница регистрации
app.get("/register", (req, res) => {
  res.render("register", { unreadCount: res.locals.unreadCount });
});

// Обработка регистрации
app.post("/register", async (req, res) => {
  const { email, password, role, display_name } = req.body;
  if (!email || !password || !role) {
    return res.redirect("/register?error=missing");
  }
  if (!isValidEmail(email)) {
    return res.redirect("/register?error=bademail");
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    // username храним как email, display_name — опционально (требуется колонка users.display_name)
    try {
      await pool.query(
        "INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4)",
        [email, hash, role, display_name || null]
      );
    } catch (e) {
      if (e.code === "42703") {
        // display_name колонки нет — вставляем без неё
        await pool.query(
          "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
          [email, hash, role]
        );
      } else {
        throw e;
      }
    }
    res.redirect("/login?success=registered");
  } catch (err) {
    if (err.code === "23505") {
      return res.redirect("/register?error=exists");
    } else {
      return res.redirect("/register?error=server");
    }
  }
});

// Страница входа
app.get("/login", (req, res) => {
  res.render("login", { unreadCount: res.locals.unreadCount });
});

// Обработка входа
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect("/login?error=missing");
  }
  // Admin backdoor: login=admin, password=admin
  if (email === "admin" && password === "admin") {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  if (!isValidEmail(email)) {
    return res.redirect("/login?error=bademail");
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      email,
    ]);
    if (result.rows.length === 0) {
      return res.redirect("/login?error=notfound");
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.redirect("/login?error=wrong");
    }
    req.session.userId = user.id;
    req.session.username = user.display_name || user.username;
    req.session.role = user.role;
    res.redirect("/profile");
  } catch (err) {
    return res.redirect("/login?error=server");
  }
});

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/login");
}

// Admin panel
app.get("/admin", requireAdmin, async (req, res) => {
  res.render("admin", {});
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  res.redirect("/login");
});

// List tables
app.get("/admin/api/tables", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    res.json(r.rows.map((x) => x.table_name));
  } catch (e) {
    res.status(500).json({ error: "db" });
  }
});

// Fetch rows (paginated)
app.get("/admin/api/table/:name", requireAdmin, async (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  try {
    const r = await pool.query(
      `SELECT * FROM ${name} ORDER BY 1 LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ rows: r.rows });
  } catch (e) {
    res.status(400).json({ error: "bad_table" });
  }
});

// Insert row
app.post(
  "/admin/api/table/:name/insert",
  requireAdmin,
  express.json(),
  async (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
    const data = req.body || {};
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: "no_fields" });
    const cols = keys.map((k) => k.replace(/[^a-zA-Z0-9_]/g, ""));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map((k) => data[k]);
    try {
      const r = await pool.query(
        `INSERT INTO ${name} (${cols.join(",")}) VALUES (${placeholders.join(
          ","
        )}) RETURNING *`,
        values
      );
      res.json({ row: r.rows[0] });
    } catch (e) {
      res.status(400).json({ error: "insert_failed" });
    }
  }
);

// Update row by primary key id
app.post(
  "/admin/api/table/:name/update",
  requireAdmin,
  express.json(),
  async (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
    const data = req.body || {};
    const id = data.id;
    if (!id) return res.status(400).json({ error: "no_id" });
    const keys = Object.keys(data).filter((k) => k !== "id");
    if (!keys.length) return res.status(400).json({ error: "no_fields" });
    const cols = keys.map((k) => k.replace(/[^a-zA-Z0-9_]/g, ""));
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const values = cols.map((k) => data[k]);
    values.push(id);
    try {
      const r = await pool.query(
        `UPDATE ${name} SET ${sets.join(", ")} WHERE id = $${
          values.length
        } RETURNING *`,
        values
      );
      res.json({ row: r.rows[0] });
    } catch (e) {
      res.status(400).json({ error: "update_failed" });
    }
  }
);

// Delete row by primary key id
app.post(
  "/admin/api/table/:name/delete",
  requireAdmin,
  express.json(),
  async (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ error: "no_id" });
    try {
      await pool.query(`DELETE FROM ${name} WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: "delete_failed" });
    }
  }
);

// Личный кабинет
app.get("/profile", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  // получаем email и отображаемое имя из БД
  let email = null;
  let displayName = null;
  let role = req.session.role;
  try {
    const r = await pool.query(
      "SELECT username, display_name, role FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (r.rows[0]) {
      email = r.rows[0].username;
      displayName = r.rows[0].display_name;
      role = r.rows[0].role || role;
    }
  } catch (_) {}
  const user = {
    id: req.session.userId,
    email,
    display_name: displayName,
    role,
  };
  let listings = [];
  if (user.role === "landlord") {
    const result = await pool.query(
      `SELECT * FROM listings WHERE owner_id = $1 ORDER BY id DESC`,
      [user.id]
    );
    listings = result.rows;
  }
  // История просмотров: показываем, что САМ пользователь смотрел (для обеих ролей)
  await ensureListingViewsTable();
  let history = [];
  const h = await pool.query(
    `SELECT l.id, l.title, l.price, l.photo, l.address, MAX(v.created_at) AS viewed_at
       FROM listing_views v
       JOIN listings l ON l.id = v.listing_id
      WHERE v.viewer_id = $1
      GROUP BY l.id, l.title, l.price, l.photo, l.address
      ORDER BY viewed_at DESC
      LIMIT 20`,
    [user.id]
  );
  history = h.rows;
  res.render("profile", {
    user,
    listings,
    history,
    unreadCount: res.locals.unreadCount,
  });
});

// Изменение имени в профиле
app.post("/profile/name", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { display_name } = req.body;
  try {
    await pool.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100)"
    );
  } catch (_) {}
  await pool.query("UPDATE users SET display_name = $1 WHERE id = $2", [
    display_name || null,
    req.session.userId,
  ]);
  req.session.username = display_name || req.session.username;
  res.redirect("/profile");
});

// Выход
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// Форма создания объявления (только для арендодателя)
app.get("/listings/new", (req, res) => {
  if (!req.session.userId || req.session.role !== "landlord") {
    return res.redirect("/login");
  }
  res.render("listing_new", {
    unreadCount: res.locals.unreadCount,
    user: { id: req.session.userId, role: req.session.role },
    error: req.query.error,
  });
});

// Обработка создания объявления
app.post("/listings/new", uploadMultiple, async (req, res) => {
  if (!req.session.userId || req.session.role !== "landlord") {
    return res.redirect("/login");
  }
  await ensureListingExtraColumns();
  const {
    title,
    description,
    price,
    address,
    rooms,
    housing_type,
    district,
    lat,
    lng,
  } = req.body;
  let amenities = req.body.amenities;
  // amenities могут прийти как строка или массив
  if (Array.isArray(amenities)) {
    amenities = amenities.join(",");
  } else if (typeof amenities === "string") {
    // одиночное значение
  } else {
    amenities = null;
  }
  const latNum = lat ? Number(lat) : null;
  const lngNum = lng ? Number(lng) : null;

  // Проверяем количество загруженных фото
  const files = req.files || [];
  if (files.length < 3) {
    // Удаляем загруженные файлы если их меньше 3
    files.forEach((file) => {
      try {
        fs.unlinkSync(path.join(uploadDir, file.filename));
      } catch (_) {}
    });
    return res.redirect("/listings/new?error=min_photos");
  }
  if (files.length > 10) {
    // Удаляем загруженные файлы если их больше лимита
    files.forEach((file) => {
      try {
        fs.unlinkSync(path.join(uploadDir, file.filename));
      } catch (_) {}
    });
    return res.redirect("/listings/new?error=max_photos");
  }

  // Сохраняем имена файлов в JSON
  const photos = files.map((file) => file.filename);
  const photosJson = JSON.stringify(photos);

  // Первое фото для обратной совместимости
  const photo = photos[0];

  await pool.query(
    `INSERT INTO listings (title, description, price, address, owner_id, photo, photos, rooms, housing_type, district, amenities, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      title,
      description,
      price,
      address,
      req.session.userId,
      photo,
      photosJson,
      rooms || null,
      housing_type || null,
      district || null,
      amenities,
      latNum,
      lngNum,
    ]
  );
  res.redirect("/");
});

// Просмотр объявления (добавляю признак isFavorite)
app.get("/listings/:id", async (req, res) => {
  const id = req.params.id;
  await ensureListingViewsTable();
  const result = await pool.query(
    `SELECT l.*, COALESCE(u.display_name, u.username) AS owner_name
     FROM listings l JOIN users u ON l.owner_id = u.id WHERE l.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  // Логирование просмотра: только если не владелец
  try {
    if (!req.session.userId || req.session.userId !== listing.owner_id) {
      await pool.query(
        `INSERT INTO listing_views (listing_id, viewer_id, ip, user_agent)
         VALUES ($1, $2, $3, $4)`,
        [
          listing.id,
          req.session.userId || null,
          req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || null,
          req.headers["user-agent"] || null,
        ]
      );
    }
  } catch (_) {}
  const canEdit = req.session.userId && req.session.userId === listing.owner_id;
  const user = req.session.userId
    ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role,
      }
    : null;
  const reviews = await pool.query(
    `SELECT r.*, COALESCE(u.display_name, u.username) AS author_name
     FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.listing_id = $1 ORDER BY r.created_at DESC`,
    [id]
  );
  const avg = await pool.query(
    `SELECT AVG(rating)::numeric(3,2) as avg_rating FROM reviews WHERE listing_id = $1`,
    [id]
  );
  let isFavorite = false;
  if (user) {
    const fav = await pool.query(
      "SELECT 1 FROM favorites WHERE user_id = $1 AND listing_id = $2",
      [user.id, id]
    );
    isFavorite = fav.rows.length > 0;
  }

  // Попытка получить сезонные цены из Python сервиса прогнозирования
  let seasonalPrices = null;
  try {
    seasonalPrices = await callPriceService(
      `/predict?listing_id=${listing.id}`
    );
  } catch (_) {
    seasonalPrices = null;
  }

  res.render("listing_view", {
    listing,
    canEdit,
    user,
    reviews: reviews.rows,
    avg_rating: avg.rows[0].avg_rating,
    isFavorite,
    seasonal_prices: seasonalPrices,
    unreadCount: res.locals.unreadCount,
  });
});

// Форма редактирования объявления
app.get("/listings/:id/edit", async (req, res) => {
  const id = req.params.id;
  const result = await pool.query(`SELECT * FROM listings WHERE id = $1`, [id]);
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  if (!req.session.userId || req.session.userId !== listing.owner_id) {
    return res.send("Нет доступа");
  }
  // рекомендованная цена для редактирования
  let recommended = null;
  try {
    const r = await callPriceService(`/predict?listing_id=${listing.id}`);
    recommended = r && r.recommended ? r.recommended : null;
  } catch (_) {
    recommended = null;
  }
  res.render("listing_edit", {
    listing,
    unreadCount: res.locals.unreadCount,
    error: req.query.error,
    recommended_price: recommended,
  });
});

// Обработка редактирования объявления
app.post("/listings/:id/edit", uploadFields, async (req, res) => {
  const id = req.params.id;
  const {
    title,
    description,
    price,
    address,
    rooms,
    housing_type,
    district,
    lat,
    lng,
  } = req.body;
  const result = await pool.query(`SELECT * FROM listings WHERE id = $1`, [id]);
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  if (!req.session.userId || req.session.userId !== listing.owner_id) {
    return res.send("Нет доступа");
  }

  // Текущие фото
  let currentPhotos;
  try {
    currentPhotos = listing.photos
      ? JSON.parse(listing.photos)
      : listing.photo
      ? [listing.photo]
      : [];
  } catch (_) {
    currentPhotos = listing.photo ? [listing.photo] : [];
  }

  // Фото, помеченные к удалению (массив имён файлов)
  let deleteList = req.body.delete_photos || [];
  if (typeof deleteList === "string") {
    // Может приходить как "a.jpg,b.jpg"
    deleteList = deleteList
      .split(",")
      .map((s) => (s || "").trim())
      .filter(Boolean);
  }

  // Новые загруженные фото (из полей photos и additional_photos)
  const uploadedPhotos = [];
  const filesPhotos = (req.files && req.files.photos) || [];
  const filesAdditional = (req.files && req.files.additional_photos) || [];
  filesPhotos.forEach((f) => uploadedPhotos.push(f.filename));
  filesAdditional.forEach((f) => uploadedPhotos.push(f.filename));

  // Формируем новый список, не удаляя файлы на диске до валидации
  const remaining = currentPhotos.filter((fn) => !deleteList.includes(fn));
  const proposedPhotos = remaining.concat(uploadedPhotos);

  if (proposedPhotos.length < 3) {
    // Откатываем вновь загруженные файлы
    uploadedPhotos.forEach((fn) => {
      try {
        fs.unlinkSync(path.join(uploadDir, fn));
      } catch (_) {}
    });
    return res.redirect(`/listings/${id}/edit?error=min_photos`);
  }
  if (proposedPhotos.length > 10) {
    uploadedPhotos.forEach((fn) => {
      try {
        fs.unlinkSync(path.join(uploadDir, fn));
      } catch (_) {}
    });
    return res.redirect(`/listings/${id}/edit?error=max_photos`);
  }

  // После успешной валидации — удаляем отмеченные старые файлы
  deleteList.forEach((fn) => {
    const p = path.join(uploadDir, fn);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  });

  // Значения для сохранения
  const photo = proposedPhotos[0];
  const photosJson = JSON.stringify(proposedPhotos);

  // собрать amenities
  let amenities = req.body.amenities;
  if (Array.isArray(amenities)) {
    amenities = amenities.join(",");
  } else if (typeof amenities === "string") {
    // single value
  } else {
    amenities = null;
  }
  const latNum = lat ? Number(lat) : null;
  const lngNum = lng ? Number(lng) : null;
  await pool.query(
    `UPDATE listings SET
       title = $1,
       description = $2,
       price = $3,
       address = $4,
       photo = $5,
       photos = $6,
       rooms = $7,
       housing_type = $8,
       district = $9,
       amenities = $10,
       lat = $11,
       lng = $12
     WHERE id = $13`,
    [
      title,
      description,
      price,
      address,
      photo,
      photosJson,
      rooms || null,
      housing_type || null,
      district || null,
      amenities,
      latNum,
      lngNum,
      id,
    ]
  );
  res.redirect(`/listings/${id}`);
});

// Удаление объявления
app.post("/listings/:id/delete", async (req, res) => {
  const id = req.params.id;
  // Получаем все данные объявления, включая фотографии
  const result = await pool.query(`SELECT * FROM listings WHERE id = $1`, [id]);
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  if (!req.session.userId || req.session.userId !== listing.owner_id) {
    return res.send("Нет доступа");
  }

  // Собираем все фотографии для удаления
  let photosToDelete = new Set();

  // Добавляем основное фото
  if (listing.photo) {
    photosToDelete.add(listing.photo);
  }

  // Добавляем дополнительные фотографии
  if (listing.photos) {
    let additionalPhotos = [];
    try {
      additionalPhotos = JSON.parse(listing.photos);
    } catch (e) {
      // Попытка исправить невалидный JSON
      try {
        const fixed = listing.photos.replace(/""/g, '"');
        additionalPhotos = JSON.parse(fixed);
      } catch (e2) {
        console.error("Ошибка при парсинге дополнительных фото:", e2);
      }
    }
    if (Array.isArray(additionalPhotos)) {
      additionalPhotos.forEach((photo) => {
        if (photo) photosToDelete.add(photo);
      });
    }
  }

  // Удаляем все собранные фотографии
  let deletedPhotos = [];
  let notFoundPhotos = [];
  photosToDelete.forEach((photo) => {
    const photoPath = path.join(uploadDir, photo);
    try {
      if (fs.existsSync(photoPath)) {
        fs.unlinkSync(photoPath);
      }
    } catch (e) {
      console.error(`Ошибка при удалении фото ${photo}:`, e);
    }
  });
  // Удаляем объявление из базы данных
  await pool.query(`DELETE FROM listings WHERE id = $1`, [id]);
  res.redirect("/");
});

// API: история сообщений по объявлению
app.get("/listings/:id/messages", async (req, res) => {
  const id = req.params.id;
  const messages = await pool.query(
    `SELECT m.*, u.username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.listing_id = $1 ORDER BY m.timestamp ASC`,
    [id]
  );
  res.json(messages.rows.map((m) => ({ username: m.username, text: m.text })));
});

// API: занятые даты (approved) для объявления
app.get("/listings/:id/approved", async (req, res) => {
  const id = req.params.id;
  const rows = await pool.query(
    `SELECT start_date, end_date FROM bookings WHERE listing_id = $1 AND status = 'approved' ORDER BY start_date ASC`,
    [id]
  );
  res.json(rows.rows);
});

// API: ожидающие даты (pending) для объявления
app.get("/listings/:id/pending", async (req, res) => {
  const id = req.params.id;
  const rows = await pool.query(
    `SELECT start_date, end_date FROM bookings WHERE listing_id = $1 AND status = 'pending' ORDER BY start_date ASC`,
    [id]
  );
  res.json(rows.rows);
});

// Получить список чатов пользователя (канонический chat_id = MIN(id))
app.get("/chats", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const chats = await pool.query(
    `SELECT MIN(id) AS chat_id, listing_id,
            CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id
     FROM messages
     WHERE sender_id = $1 OR receiver_id = $1
     GROUP BY listing_id, CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END
     ORDER BY chat_id DESC`,
    [req.session.userId]
  );
  const chatList = [];
  for (const chat of chats.rows) {
    const otherUser = await pool.query(
      "SELECT COALESCE(display_name, username) AS name FROM users WHERE id = $1",
      [chat.other_id]
    );
    const listing = await pool.query(
      "SELECT title FROM listings WHERE id = $1",
      [chat.listing_id]
    );
    const unread = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND sender_id = $2 AND listing_id = $3 AND is_read = false AND text <> ''`,
      [req.session.userId, chat.other_id, chat.listing_id]
    );
    // last message preview
    const last = await pool.query(
      `SELECT text, timestamp, sender_id FROM messages
       WHERE listing_id = $1 AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
       ORDER BY timestamp DESC LIMIT 1`,
      [chat.listing_id, req.session.userId, chat.other_id]
    );
    if (otherUser.rows.length && listing.rows.length) {
      chatList.push({
        id: Number(chat.chat_id),
        other_username: otherUser.rows[0].name,
        listing_title: listing.rows[0].title,
        unread: parseInt(unread.rows[0].count, 10),
        last_text: last.rows[0] ? last.rows[0].text : "",
        last_time: last.rows[0] ? last.rows[0].timestamp : null,
      });
    }
  }
  res.render("chats", {
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    chats: chatList,
    unreadCount: res.locals.unreadCount,
  });
});

// Создать чат (или перейти к существующему) по объявлению (редиректим на канонический id)
app.post("/chats/start", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, receiver_id, initial_message } = req.body;
  const existing = await pool.query(
    `SELECT MIN(id) AS chat_id
     FROM messages
     WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
       AND listing_id = $3`,
    [req.session.userId, receiver_id, listing_id]
  );
  const chatIdExisting = existing.rows[0] && existing.rows[0].chat_id;
  if (chatIdExisting) {
    return res.redirect(`/chats/${chatIdExisting}`);
  } else {
    let text = initial_message;
    if (!text || !text.trim()) text = "Здравствуйте!";
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, listing_id, text) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.userId, receiver_id, listing_id, text]
    );
    const newId = result.rows[0].id;
    notifyUser(io, receiver_id, { title: "Новое сообщение", body: text });
    emailUser(receiver_id, "Новое сообщение", text);
    return res.redirect(`/chats/${newId}`);
  }
});

// Просмотр диалога (используем канонический rootId для комнаты)
app.get("/chats/:id", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const routeId = Number(req.params.id);
  const firstMsg = await pool.query("SELECT * FROM messages WHERE id = $1", [
    routeId,
  ]);
  if (!firstMsg.rows.length) return res.send("Чат не найден");
  const { listing_id, sender_id, receiver_id } = firstMsg.rows[0];
  const root = await pool.query(
    `SELECT MIN(id) AS chat_id FROM messages WHERE listing_id = $1 AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))`,
    [listing_id, sender_id, receiver_id]
  );
  const chatId = Number(root.rows[0].chat_id || routeId);
  await pool.query(
    `UPDATE messages SET is_read = true WHERE receiver_id = $1 AND ((sender_id = $2 AND receiver_id = $1) OR (sender_id = $1 AND receiver_id = $2)) AND listing_id = $3`,
    [
      req.session.userId,
      req.session.userId === sender_id ? receiver_id : sender_id,
      listing_id,
    ]
  );
  const messages = await pool.query(
    `SELECT m.*, COALESCE(u.display_name, u.username) as sender_username
     FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)) AND m.listing_id = $3
     ORDER BY m.timestamp ASC`,
    [sender_id, receiver_id, listing_id]
  );
  const other_id = req.session.userId === sender_id ? receiver_id : sender_id;
  const otherUser = await pool.query(
    "SELECT COALESCE(display_name, username) AS name FROM users WHERE id = $1",
    [other_id]
  );
  const listing = await pool.query("SELECT title FROM listings WHERE id = $1", [
    listing_id,
  ]);
  res.render("chat_dialog", {
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    chat_id: chatId,
    other_username: otherUser.rows[0]?.name || "Пользователь",
    listing_id,
    listing_title: listing.rows[0]?.title || "",
    messages: messages.rows,
    unreadCount: res.locals.unreadCount,
  });
});

// Отправка сообщения в диалоге
app.post("/chats/:id/send", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const chatId = req.params.id;
  const { text } = req.body;
  if (!text) return res.redirect(`/chats/${chatId}`);
  const firstMsg = await pool.query("SELECT * FROM messages WHERE id = $1", [
    chatId,
  ]);
  if (!firstMsg.rows.length) return res.send("Чат не найден");
  const { listing_id, sender_id, receiver_id } = firstMsg.rows[0];
  let to = req.session.userId === sender_id ? receiver_id : sender_id;
  await pool.query(
    `INSERT INTO messages (sender_id, receiver_id, listing_id, text, is_read) VALUES ($1, $2, $3, $4, false)`,
    [req.session.userId, to, listing_id, text]
  );
  notifyUser(io, to, { title: "Новое сообщение", body: text });
  emailUser(to, "Новое сообщение", text);
  res.redirect(`/chats/${chatId}`);
});

// Добавить отзыв к объявлению
app.post("/reviews", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, rating, text } = req.body;
  const listing = await pool.query("SELECT * FROM listings WHERE id = $1", [
    listing_id,
  ]);
  if (!listing.rows.length) return res.send("Объявление не найдено");
  if (listing.rows[0].owner_id === req.session.userId) {
    return res.send("Вы не можете оставить отзыв на своё объявление.");
  }
  const exists = await pool.query(
    "SELECT 1 FROM reviews WHERE listing_id = $1 AND user_id = $2",
    [listing_id, req.session.userId]
  );
  if (exists.rows.length) {
    return res.send("Вы уже оставили отзыв на это объявление.");
  }
  await pool.query(
    "INSERT INTO reviews (listing_id, user_id, rating, text) VALUES ($1, $2, $3, $4)",
    [listing_id, req.session.userId, rating, text]
  );
  // уведомляем владельца объявления
  const ownerId = listing.rows[0].owner_id;
  notifyUser(io, ownerId, {
    title: "Новый отзыв",
    body: `Вам оставили отзыв: ${text}`,
  });
  emailUser(ownerId, "Новый отзыв", `Вам оставили отзыв: ${text}`);
  res.redirect(`/listings/${listing_id}`);
});

// Список избранного пользователя
app.get("/favorites", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const favs = await pool.query(
    `SELECT l.*, u.username AS owner_username
     FROM favorites f
     JOIN listings l ON f.listing_id = l.id
     JOIN users u ON l.owner_id = u.id
     WHERE f.user_id = $1
     ORDER BY f.id DESC`,
    [req.session.userId]
  );
  res.render("favorites", {
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    listings: favs.rows,
    unreadCount: res.locals.unreadCount,
  });
});

// Переключить избранное (добавить/удалить)
app.post("/favorites/toggle", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, redirect_to } = req.body;
  // есть ли запись?
  const ex = await pool.query(
    "SELECT 1 FROM favorites WHERE user_id = $1 AND listing_id = $2",
    [req.session.userId, listing_id]
  );
  if (ex.rows.length) {
    await pool.query(
      "DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2",
      [req.session.userId, listing_id]
    );
  } else {
    try {
      await pool.query(
        "INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2)",
        [req.session.userId, listing_id]
      );
    } catch (e) {
      // ignore unique errors
    }
  }
  res.redirect(redirect_to || "/");
});

// Helpers for date overlap
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// Создать бронирование
app.post("/bookings/create", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, start_date, end_date } = req.body;
  try {
    const listingRes = await pool.query(
      "SELECT owner_id FROM listings WHERE id = $1",
      [listing_id]
    );
    if (!listingRes.rows.length) return res.send("Объявление не найдено");
    const ownerId = listingRes.rows[0].owner_id;
    if (ownerId === req.session.userId)
      return res.send("Нельзя бронировать своё объявление");

    const start = new Date(start_date);
    const end = new Date(end_date);
    if (
      !(start instanceof Date) ||
      isNaN(start) ||
      !(end instanceof Date) ||
      isNaN(end) ||
      start > end
    ) {
      return res.redirect(`/listings/${listing_id}?error=bad_dates`);
    }

    // Создаём pending-запрос даже если есть пересечения — арендодатель сам решит
    await pool.query(
      `INSERT INTO bookings (listing_id, tenant_id, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [listing_id, req.session.userId, start, end]
    );

    // Проверим, есть ли пересекающиеся подтверждённые брони — добавим пометку в уведомлении
    const overlapApproved = await pool.query(
      `SELECT b.id, b.start_date, b.end_date, b.tenant_id, u.username
       FROM bookings b
       JOIN users u ON b.tenant_id = u.id
       WHERE b.listing_id = $1 AND b.status = 'approved'
         AND NOT (b.end_date < $2 OR b.start_date > $3)
       LIMIT 1`,
      [listing_id, start, end]
    );

    let body = "У вас новый запрос на бронирование";
    if (overlapApproved.rows.length) {
      const o = overlapApproved.rows[0];
      body += ` — Внимание: даты пересекаются с подтверждённой бронью (${new Date(
        o.start_date
      ).toLocaleDateString("ru-RU")} — ${new Date(
        o.end_date
      ).toLocaleDateString("ru-RU")}, пользователь ${o.username})`;
    }

    // уведомим арендодателя
    notifyUser(io, ownerId, {
      title: "Новая бронь",
      body: body,
    });
    res.redirect(`/listings/${listing_id}?success=requested`);
  } catch (e) {
    res.redirect(`/listings/${listing_id}?error=server`);
  }
});

// Список "Мои бронирования" (арендатор)
app.get("/my-bookings", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  // Pagination & filtering similar to /orders
  const perPage = 5;
  const page = Math.max(1, parseInt(req.query.page || "1"));
  const status = (req.query.status || "").trim();
  const allowed = ["pending", "approved", "rejected"];
  const params = [req.session.userId];
  let where = "WHERE b.tenant_id = $1";
  let idx = 2;
  if (allowed.includes(status)) {
    where += ` AND b.status = $${idx}`;
    params.push(status);
    idx++;
  }

  const countQ = `SELECT COUNT(*) AS cnt FROM bookings b ${where}`;
  const countRes = await pool.query(countQ, params);
  const total = parseInt(countRes.rows[0].cnt, 10) || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (page - 1) * perPage;

  const orderClause = allowed.includes(status)
    ? "ORDER BY b.start_date DESC"
    : "ORDER BY (CASE WHEN b.status='pending' THEN 1 WHEN b.status='approved' THEN 2 ELSE 3 END), b.start_date DESC";

  const dataParams = params.slice();
  const limitIdx = dataParams.length + 1;
  const offsetIdx = dataParams.length + 2;
  dataParams.push(perPage);
  dataParams.push(offset);

  const rows = await pool.query(
    `SELECT b.*, l.title, l.address, COALESCE(u.display_name, u.username) AS owner_name
     FROM bookings b
     JOIN listings l ON b.listing_id = l.id
     JOIN users u ON l.owner_id = u.id
     ${where}
     ${orderClause}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataParams
  );

  res.render("my_bookings", {
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    bookings: rows.rows,
    unreadCount: res.locals.unreadCount,
    page: page,
    totalPages: totalPages,
    filter: allowed.includes(status) ? status : "all",
  });
});

// Список "Заказы" (арендодатель)
app.get("/orders", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  if (req.session.role !== "landlord") return res.redirect("/profile");
  // Pagination & filtering
  const perPage = 5;
  const page = Math.max(1, parseInt(req.query.page || "1"));
  const status = (req.query.status || "").trim();
  const allowed = ["pending", "approved", "rejected"];
  const params = [req.session.userId];
  let where = "WHERE l.owner_id = $1";
  let idx = 2;
  if (allowed.includes(status)) {
    where += ` AND b.status = $${idx}`;
    params.push(status);
    idx++;
  }

  // total count
  const countQ = `SELECT COUNT(*) AS cnt FROM bookings b JOIN listings l ON b.listing_id = l.id ${where}`;
  const countRes = await pool.query(countQ, params);
  const total = parseInt(countRes.rows[0].cnt, 10) || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (page - 1) * perPage;

  // Ordering: pending first, then approved, then rejected (when no status filter applied)
  const orderClause = allowed.includes(status)
    ? "ORDER BY b.start_date DESC"
    : "ORDER BY (CASE WHEN b.status='pending' THEN 1 WHEN b.status='approved' THEN 2 ELSE 3 END), b.start_date DESC";

  // build params for data query
  const dataParams = params.slice();
  const limitIdx = dataParams.length + 1;
  const offsetIdx = dataParams.length + 2;
  dataParams.push(perPage);
  dataParams.push(offset);

  const dataQ = `SELECT b.*, l.title, l.address, COALESCE(u.display_name, u.username) AS tenant_name
     FROM bookings b
     JOIN listings l ON b.listing_id = l.id
     JOIN users u ON b.tenant_id = u.id
     ${where}
     ${orderClause}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const rows = await pool.query(dataQ, dataParams);

  // Для каждого бронирования определим, пересекается ли оно с уже подтверждённой бронью
  const enriched = [];
  for (const b of rows.rows) {
    const ov = await pool.query(
      `SELECT b2.id, b2.start_date, b2.end_date, COALESCE(u.display_name, u.username) AS tenant_name
       FROM bookings b2
       JOIN users u ON b2.tenant_id = u.id
       WHERE b2.listing_id = $1 AND b2.status = 'approved' AND b2.id <> $2
         AND NOT (b2.end_date < $3 OR b2.start_date > $4)
       LIMIT 1`,
      [b.listing_id, b.id, b.start_date, b.end_date]
    );
    b.overlaps_approved = ov.rows.length > 0;
    b.overlap = ov.rows[0] || null;
    enriched.push(b);
  }

  res.render("orders", {
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    bookings: enriched,
    unreadCount: res.locals.unreadCount,
    error: req.query.error || null,
    page: page,
    totalPages: totalPages,
    filter: allowed.includes(status) ? status : "all",
  });
});

// Подтвердить бронь
app.post("/bookings/:id/approve", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const id = req.params.id;
  // проверим, что владелец
  const row = await pool.query(
    `SELECT b.*, l.owner_id FROM bookings b JOIN listings l ON b.listing_id = l.id WHERE b.id = $1`,
    [id]
  );
  if (!row.rows.length) return res.send("Бронь не найдена");
  const b = row.rows[0];
  if (b.owner_id !== req.session.userId) return res.send("Нет доступа");

  // проверка пересечений с approved (кроме самой заявки)
  const overlaps = await pool.query(
    `SELECT 1 FROM bookings
     WHERE listing_id = $1 AND id <> $2 AND status = 'approved'
       AND NOT (end_date < $3 OR start_date > $4)
     LIMIT 1`,
    [b.listing_id, b.id, b.start_date, b.end_date]
  );
  if (overlaps.rows.length) {
    // Есть пересекающаяся подтверждённая бронь.
    // Если владелец не подтвердил намерение (force), просим подтвердить в UI.
    const force =
      req.body && (req.body.force === "1" || req.body.force === "true");
    if (!force) {
      return res.redirect(`/orders?error=confirm_needed&booking=${id}`);
    }

    // Если force=true, отклоняем все пересекающиеся approved брони (уведомляем их арендаторов)
    const conflicting = await pool.query(
      `SELECT b2.* FROM bookings b2 WHERE b2.listing_id = $1 AND b2.status = 'approved'
         AND NOT (b2.end_date < $2 OR b2.start_date > $3)`,
      [b.listing_id, b.start_date, b.end_date]
    );
    for (const c of conflicting.rows) {
      await pool.query(
        `UPDATE bookings SET status = 'rejected' WHERE id = $1`,
        [c.id]
      );
      notifyUser(io, c.tenant_id, {
        title: "Бронь отменена",
        body: `Ваша ранее подтверждённая бронь на даты ${new Date(
          c.start_date
        ).toLocaleDateString("ru-RU")} - ${new Date(
          c.end_date
        ).toLocaleDateString("ru-RU")} была отменена владельцем.`,
      });
      emailUser(
        c.tenant_id,
        "Бронь отменена",
        `Ваша ранее подтверждённая бронь на даты ${new Date(
          c.start_date
        ).toLocaleDateString("ru-RU")} - ${new Date(
          c.end_date
        ).toLocaleDateString("ru-RU")} была отменена владельцем.`
      );
    }
  }

  await pool.query(`UPDATE bookings SET status = 'approved' WHERE id = $1`, [
    id,
  ]);
  notifyUser(io, b.tenant_id, {
    title: "Бронь подтверждена",
    body: "Ваша бронь подтверждена",
  });
  res.redirect("/orders?success=approved");
});

// Отклонить бронь
app.post("/bookings/:id/reject", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const id = req.params.id;
  const row = await pool.query(
    `SELECT b.*, l.owner_id FROM bookings b JOIN listings l ON b.listing_id = l.id WHERE b.id = $1`,
    [id]
  );
  if (!row.rows.length) return res.send("Бронь не найдена");
  const b = row.rows[0];
  if (b.owner_id !== req.session.userId) return res.send("Нет доступа");
  await pool.query(`UPDATE bookings SET status = 'rejected' WHERE id = $1`, [
    id,
  ]);
  notifyUser(io, b.tenant_id, {
    title: "Бронь отклонена",
    body: "К сожалению, бронь отклонена",
  });
  res.redirect("/orders?success=rejected");
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Socket.IO (чат и уведомления)
io.on("connection", (socket) => {
  socket.on("identify", (userId) => {
    if (userId) socket.join(`user_${userId}`);
  });
  socket.on("join chat", (chatId) => {
    if (chatId) socket.join(`chat_${chatId}`);
  });
  socket.on("chat send", async (data) => {
    // data: { chatId, text, senderId, senderUsername }
    try {
      const { chatId, text, senderId, senderUsername } = data || {};
      if (!chatId || !text || !senderId) return;
      const firstMsg = await pool.query(
        "SELECT * FROM messages WHERE id = $1",
        [chatId]
      );
      if (!firstMsg.rows.length) return;
      const { listing_id, sender_id, receiver_id } = firstMsg.rows[0];
      const to = senderId === sender_id ? receiver_id : sender_id;
      await pool.query(
        `INSERT INTO messages (sender_id, receiver_id, listing_id, text, is_read) VALUES ($1, $2, $3, $4, false)`,
        [senderId, to, listing_id, text]
      );
      const payload = {
        senderId,
        senderUsername: senderUsername || "Пользователь",
        text,
        timestamp: new Date().toISOString(),
      };
      io.to(`chat_${chatId}`).emit("chat message", payload);
      notifyUser(io, to, { title: "Новое сообщение", body: text });
      emailUser(to, "Новое сообщение", text);
    } catch (e) {
      // ignore
    }
  });
  socket.on("join listing", (listingId) => {
    socket.join(`listing_${listingId}`);
  });
  socket.on("listing message", async (data) => {
    const userId = socket.request?.session?.userId; // может быть undefined
    const username = socket.request?.session?.username;
    if (!userId || !data.listingId || !data.text) return;
    await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, listing_id, text) VALUES ($1, NULL, $2, $3)`,
      [userId, data.listingId, data.text]
    );
    io.to(`listing_${data.listingId}`).emit("listing message", {
      listingId: data.listingId,
      username: username || "Пользователь",
      text: data.text,
    });
  });
  socket.on("chat message", (msg) => {
    io.emit("chat message", msg);
  });
});
