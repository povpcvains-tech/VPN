const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище: рандомный ID -> { content: "fydfye", count: 0 }
let subscriptions = {};

// Генерация рандомных букв (6 символов)
function generateRandomId() {
    return Math.random().toString(36).substring(2, 8);
}

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Главная страница — создатель вводит содержимое
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
                .delete-btn { background: #d32f2f; }
                .decrement-btn { background: #ff9800; }
                code { background: #0d1117; padding: 4px 8px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🔐 VPN Подписка — Создать ссылку</h1>
                <form action="/generate" method="POST">
                    <input type="text" name="content" placeholder="Введите содержимое ссылки (например: fydfye)" required>
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

// Генерация ссылки с рандомным ID
app.post('/generate', (req, res) => {
    const content = req.body.content;
    const randomId = generateRandomId();
    subscriptions[randomId] = {
        content: content,
        count: 0
    };
    res.redirect('/');
});

// Переход по ссылке — показываем содержимое и увеличиваем счётчик
app.get('/p/:id', (req, res) => {
    const id = req.params.id;
    
    if (subscriptions.hasOwnProperty(id)) {
        subscriptions[id].count++; // +1 человек перешёл
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>VPN Подключение</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 3rem; background: #0d1117; color: #fff; }
                    .card { background: #161b22; padding: 2rem; border-radius: 16px; display: inline-block; max-width: 500px; }
                    .content { background: #238636; padding: 1rem; border-radius: 8px; font-size: 24px; word-break: break-all; }
                    .count { font-size: 32px; color: #58a6ff; margin-top: 1rem; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>🔐 VPN Доступ</h1>
                    <div class="content">
                        ${subscriptions[id].content}
                    </div>
                    <p class="count">👥 Всего переходов: ${subscriptions[id].count}</p>
                    <p><small>Ссылка: /p/${id}</small></p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(404).send('Ссылка не найдена');
    }
});

// Удалить одного пользователя (минус 1)
app.post('/decrement/:id', (req, res) => {
    const id = req.params.id;
    if (subscriptions.hasOwnProperty(id) && subscriptions[id].count > 0) {
        subscriptions[id].count--;
    }
    res.redirect('/');
});

// Полностью удалить ссылку
app.post('/delete/:id', (req, res) => {
    const id = req.params.id;
    delete subscriptions[id];
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});
