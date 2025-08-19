// Подключение к серверу через Socket.IO
const socket = io();

// Пример: выводим полученные сообщения в консоль
socket.on("chat message", (msg) => {
  console.log("Новое сообщение:", msg);
});
