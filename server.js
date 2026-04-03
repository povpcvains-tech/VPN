const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище: { randomId: { content: '...', count: 0 } }
let subscriptions = {};

function generateRandomId() {
    return Math.random().toString(36).substring(2, 8);
}

app.use(express.urlencoded({ extended: true }));

// Главная страница — форма создания
app.get('/', (req, res) => {
    let linksHtml = '';
    for (const [id, data] of Object.entries(subscriptions)) {
        linksHtml += `
            <div style="margin: 10px 0; padding: 10px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <strong>📝 Содержимое:</strong> ${data.content}<br>
                <code style="color: #0f0;">/p/${id}</code><br>
                👥 ${data.count} человек перешло
                <form action="/delete/${id}" method="POST" style="display: inline;">
                    <button type="submit" style="background: #d32f2f; color: white; border: none; padding: 5px 10px; border-radius: 4px;">🗑 Удалить</button>
                </form>
                <form action="/decrement/${id}" method="POST" style="display: inline;">
                    <button type="submit" style="background: #ff9800; color: white; border: none; padding: 5px 10px; border-radius: 4px;">➖ −1</button>
                </form>
            </div>
        `;
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>VPN Подписка — Генератор</title>
            <style>
                body { font-family: Arial; padding: 2rem; background: #0d1117; color: #fff; }
                .card { background: #161b22; padding: 1.5rem; border-radius: 12px; margin-bottom: 1rem; }
                input, button { padding: 10px; margin: 5px; border-radius: 6px; border: none; }
                input { width: 250px; background: #0d1117; color: #fff; border: 1px solid #333; }
                button { background: #238636; color: white; cursor: pointer; }
                code { background: #0d1117; padding: 4px 8px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🔐 VPN Подписка — Создать ссылку</h1>
                <form action="/generate" method="POST">
                    <input type="text" name="content" placeholder="Введите содержимое ссылки (например: конфиг для VPN)" required>
                    <button type="submit">✨ Сгенерировать ссылку</button>
                </form>
            </div>
            <div class="card">
                <h2>📋 Мои ссылки</h2>
                ${linksHtml || '<p>Пока нет ни одной ссылки. Создайте первую!</p>'}
            </div>
        </body>
        </html>
    `);
});

// Обработчик генерации
app.post('/generate', (req, res) => {
    const content = req.body.content;
    const randomId = generateRandomId();
    subscriptions[randomId] = { content: content, count: 0 };
    res.redirect('/');
});

// Переход по ссылке /p/что-то — ВОЗВРАЩАЕТ ТОЛЬКО ТЕКСТ (RAW)
app.get('/p/:id', (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].count++;
        // Отправляем только содержимое как обычный текст (без HTML)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(subscriptions[id].content);
    } else {
        res.status(404).send('Link not found');
    }
});

// Удаление одного пользователя (-1)
app.post('/decrement/:id', (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].count > 0) {
        subscriptions[id].count--;
    }
    res.redirect('/');
});

// Полное удаление ссылки
app.post('/delete/:id', (req, res) => {
    delete subscriptions[req.params.id];
    res.redirect('/');
});

// Запуск сервера
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
