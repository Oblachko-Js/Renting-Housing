// Подключение к серверу через Socket.IO
(function () {
  if (!window.APP_SOCKET) {
    window.APP_SOCKET = io();
  }
})();

const appSocket = window.APP_SOCKET;

// identify текущего пользователя, если сервер встроит userId в window
if (window.CURRENT_USER_ID) {
  appSocket.emit("identify", window.CURRENT_USER_ID);
}

function isNotifEnabled() {
  return localStorage.getItem("notificationsEnabled") === "true";
}
function setNotifEnabled(v) {
  localStorage.setItem("notificationsEnabled", v ? "true" : "false");
}

// Запросить разрешение на уведомления (один раз)
(function ensureNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try {
      Notification.requestPermission();
    } catch (_) {}
  }
})();

// Показать уведомление
function showWebNotification(payload) {
  if (!("Notification" in window)) return;
  if (!isNotifEnabled()) return;
  if (Notification.permission !== "granted") return;
  const n = new Notification(payload.title || "Уведомление", {
    body: payload.body || "",
  });
  setTimeout(() => n.close && n.close(), 5000);
}

// Слушаем серверные нотификации
appSocket.on("notify", (payload) => {
  showWebNotification(payload);
});

// Кнопка вкл/выкл уведомлений
function updateNotifyToggleBtn() {
  const btn = document.getElementById("notify-toggle");
  if (!btn) return;
  const on = isNotifEnabled();
  btn.textContent = on ? "Выключить уведомления" : "Включить уведомления";
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("notify-toggle");
  if (btn) {
    updateNotifyToggleBtn();
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const enabled = isNotifEnabled();
      if (!enabled) {
        if ("Notification" in window && Notification.permission !== "granted") {
          try {
            await Notification.requestPermission();
          } catch (_) {}
        }
        setNotifEnabled(true);
      } else {
        setNotifEnabled(false);
      }
      updateNotifyToggleBtn();
    });
  }
});
