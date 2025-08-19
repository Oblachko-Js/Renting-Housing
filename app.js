const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const { Pool } = require("pg");
const path = require("path");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка подключения к PostgreSQL
const pool = new Pool({
  user: "andrejpancenko", // замени на своего пользователя
  host: "localhost",
  database: "myprogram", // замени на свою БД
  password: "", // замени на свой пароль
  port: 5432,
});

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

// Главная страница
app.get("/", async (req, res) => {
  let { q, min_price, max_price } = req.query;
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
  let sql = `SELECT l.*, u.username AS owner_username FROM listings l JOIN users u ON l.owner_id = u.id`;
  if (where.length > 0) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql += " ORDER BY l.id DESC";
  const listings = await pool.query(sql, params);
  res.render("index", {
    listings: listings.rows,
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
    unreadCount: res.locals.unreadCount,
  });
});

// Страница регистрации
app.get("/register", (req, res) => {
  res.render("register", { unreadCount: res.locals.unreadCount });
});

// Обработка регистрации
app.post("/register", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.send("Заполните все поля!");
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
      [username, hash, role]
    );
    res.redirect("/login");
  } catch (err) {
    if (err.code === "23505") {
      res.send("Пользователь с таким логином уже существует!");
    } else {
      res.send("Ошибка регистрации: " + err.message);
    }
  }
});

// Страница входа
app.get("/login", (req, res) => {
  res.render("login", { unreadCount: res.locals.unreadCount });
});

// Обработка входа
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.send("Заполните все поля!");
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    if (result.rows.length === 0) {
      return res.send("Пользователь не найден");
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.send("Неверный пароль");
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.redirect("/profile");
  } catch (err) {
    res.send("Ошибка входа: " + err.message);
  }
});

// Личный кабинет
app.get("/profile", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  const user = {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role,
  };
  let listings = [];
  if (user.role === "landlord") {
    const result = await pool.query(
      `SELECT * FROM listings WHERE owner_id = $1 ORDER BY id DESC`,
      [user.id]
    );
    listings = result.rows;
  }
  res.render("profile", {
    user,
    listings,
    unreadCount: res.locals.unreadCount,
  });
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
  res.render("listing_new", { unreadCount: res.locals.unreadCount });
});

// Обработка создания объявления
app.post("/listings/new", upload.single("photo"), async (req, res) => {
  if (!req.session.userId || req.session.role !== "landlord") {
    return res.redirect("/login");
  }
  const { title, description, price, address } = req.body;
  const photo = req.file ? req.file.filename : null;
  await pool.query(
    `INSERT INTO listings (title, description, price, address, owner_id, photo) VALUES ($1, $2, $3, $4, $5, $6)`,
    [title, description, price, address, req.session.userId, photo]
  );
  res.redirect("/");
});

// Просмотр объявления
app.get("/listings/:id", async (req, res) => {
  const id = req.params.id;
  const result = await pool.query(
    `SELECT l.*, u.username AS owner_username FROM listings l JOIN users u ON l.owner_id = u.id WHERE l.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  const canEdit = req.session.userId && req.session.userId === listing.owner_id;
  const user = req.session.userId
    ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role,
      }
    : null;
  // Получаем отзывы и средний рейтинг
  const reviews = await pool.query(
    `SELECT r.*, u.username FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.listing_id = $1 ORDER BY r.created_at DESC`,
    [id]
  );
  const avg = await pool.query(
    `SELECT AVG(rating)::numeric(3,2) as avg_rating FROM reviews WHERE listing_id = $1`,
    [id]
  );
  res.render("listing_view", {
    listing,
    canEdit,
    user,
    reviews: reviews.rows,
    avg_rating: avg.rows[0].avg_rating,
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
  res.render("listing_edit", { listing, unreadCount: res.locals.unreadCount });
});

// Обработка редактирования объявления
app.post("/listings/:id/edit", upload.single("photo"), async (req, res) => {
  const id = req.params.id;
  const { title, description, price, address } = req.body;
  const result = await pool.query(`SELECT * FROM listings WHERE id = $1`, [id]);
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  if (!req.session.userId || req.session.userId !== listing.owner_id) {
    return res.send("Нет доступа");
  }
  let photo = listing.photo;
  if (req.file) {
    photo = req.file.filename;
    // удалить старое фото
    if (listing.photo) {
      const oldPath = path.join(uploadDir, listing.photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await pool.query(
    `UPDATE listings SET title = $1, description = $2, price = $3, address = $4, photo = $5 WHERE id = $6`,
    [title, description, price, address, photo, id]
  );
  res.redirect(`/listings/${id}`);
});

// Удаление объявления
app.post("/listings/:id/delete", async (req, res) => {
  const id = req.params.id;
  const result = await pool.query(`SELECT * FROM listings WHERE id = $1`, [id]);
  if (result.rows.length === 0) return res.send("Объявление не найдено");
  const listing = result.rows[0];
  if (!req.session.userId || req.session.userId !== listing.owner_id) {
    return res.send("Нет доступа");
  }
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

// Получить список чатов пользователя
app.get("/chats", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  // Получаем все уникальные чаты пользователя (по объявлению и собеседнику)
  const chats = await pool.query(
    `
    SELECT DISTINCT ON (least(sender_id, receiver_id), greatest(sender_id, receiver_id), listing_id)
      id, listing_id,
      CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id
    FROM messages
    WHERE sender_id = $1 OR receiver_id = $1
    ORDER BY least(sender_id, receiver_id), greatest(sender_id, receiver_id), listing_id, timestamp DESC
  `,
    [req.session.userId]
  );
  // Получаем имена пользователей и названия объявлений, а также есть ли непрочитанные сообщения
  const chatList = [];
  for (const chat of chats.rows) {
    const otherUser = await pool.query(
      "SELECT username FROM users WHERE id = $1",
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
    if (otherUser.rows.length && listing.rows.length) {
      chatList.push({
        id: chat.id,
        other_username: otherUser.rows[0].username,
        listing_title: listing.rows[0].title,
        unread: parseInt(unread.rows[0].count, 10),
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

// Создать чат (или перейти к существующему) по объявлению
app.post("/chats/start", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, receiver_id, initial_message } = req.body;
  // Найти существующий чат (по сообщениям)
  const chat = await pool.query(
    `SELECT id FROM messages WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND listing_id = $3 LIMIT 1`,
    [req.session.userId, receiver_id, listing_id]
  );
  if (chat.rows.length) {
    // Переход к существующему чату
    return res.redirect(`/chats/${chat.rows[0].id}`);
  } else {
    // Создать первое сообщение (с initial_message или 'Здравствуйте!')
    let text = initial_message;
    if (!text || !text.trim()) text = "Здравствуйте!";
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, listing_id, text) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.userId, receiver_id, listing_id, text]
    );
    return res.redirect(`/chats/${result.rows[0].id}`);
  }
});

// Просмотр диалога
app.get("/chats/:id", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const chatId = req.params.id;
  // Получаем первое сообщение, чтобы узнать listing_id, участников
  const firstMsg = await pool.query("SELECT * FROM messages WHERE id = $1", [
    chatId,
  ]);
  if (!firstMsg.rows.length) return res.send("Чат не найден");
  const { listing_id, sender_id, receiver_id } = firstMsg.rows[0];
  // Помечаем все сообщения, где текущий пользователь — получатель, как прочитанные
  await pool.query(
    `UPDATE messages SET is_read = true WHERE receiver_id = $1 AND ((sender_id = $2 AND receiver_id = $1) OR (sender_id = $1 AND receiver_id = $2)) AND listing_id = $3`,
    [
      req.session.userId,
      req.session.userId === sender_id ? receiver_id : sender_id,
      listing_id,
    ]
  );
  // Получаем все сообщения этого диалога
  const messages = await pool.query(
    `SELECT m.*, u.username as sender_username FROM messages m JOIN users u ON m.sender_id = u.id WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)) AND m.listing_id = $3 ORDER BY m.timestamp ASC`,
    [sender_id, receiver_id, listing_id]
  );
  // Определяем собеседника
  const other_id = req.session.userId === sender_id ? receiver_id : sender_id;
  const otherUser = await pool.query(
    "SELECT username FROM users WHERE id = $1",
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
    other_username: otherUser.rows[0]?.username || "Пользователь",
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
  // Получаем первое сообщение, чтобы узнать listing_id, участников
  const firstMsg = await pool.query("SELECT * FROM messages WHERE id = $1", [
    chatId,
  ]);
  if (!firstMsg.rows.length) return res.send("Чат не найден");
  const { listing_id, sender_id, receiver_id } = firstMsg.rows[0];
  // Определяем собеседника
  let to = req.session.userId === sender_id ? receiver_id : sender_id;
  await pool.query(
    `INSERT INTO messages (sender_id, receiver_id, listing_id, text, is_read) VALUES ($1, $2, $3, $4, false)`,
    [req.session.userId, to, listing_id, text]
  );
  res.redirect(`/chats/${chatId}`);
});

// Добавить отзыв к объявлению
app.post("/reviews", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const { listing_id, rating, text } = req.body;
  // Проверка: нельзя оставить отзыв на своё объявление
  const listing = await pool.query("SELECT * FROM listings WHERE id = $1", [
    listing_id,
  ]);
  if (!listing.rows.length) return res.send("Объявление не найдено");
  if (listing.rows[0].owner_id === req.session.userId) {
    return res.send("Вы не можете оставить отзыв на своё объявление.");
  }
  // Проверка: нельзя оставить больше одного отзыва на одно объявление
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
  res.redirect(`/listings/${listing_id}`);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Socket.IO (чат)
io.on("connection", (socket) => {
  socket.on("join listing", (listingId) => {
    socket.join(`listing_${listingId}`);
  });
  socket.on("listing message", async (data) => {
    // data: { listingId, text }
    const userId = socket.request.session?.userId;
    const username = socket.request.session?.username;
    if (!userId || !data.listingId || !data.text) return;
    // Сохраняем сообщение в БД
    await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, listing_id, text) VALUES ($1, NULL, $2, $3)`,
      [userId, data.listingId, data.listingId, data.text]
    );
    io.to(`listing_${data.listingId}`).emit("listing message", {
      listingId: data.listingId,
      username,
      text: data.text,
    });
  });
  // ... общий чат (если нужен)
  socket.on("chat message", (msg) => {
    io.emit("chat message", msg);
  });
});
