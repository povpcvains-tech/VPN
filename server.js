const express = require('express');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище: { randomId: { content: '...', count: 0 } }
let subscriptions = {};

// Префикс, который добавляется к каждому содержимому
const PROFILE_PREFIX = '# profile-update-interval: 1\n';

// JSON-конфиг для кнопки "Уничтожить"
const DESTROY_CONFIG = `{
    "dns": {
        "queryStrategy": "IPIfNonMatch",
        "servers": [
            {
                "address": "1.1.1.1",
                "skipFallback": false
            }
        ],
        "tag": "dns_out"
    },
    "inbounds": [
        {
            "port": 10808,
            "protocol": "socks",
            "settings": {
                "auth": "noauth",
                "udp": true,
                "userLevel": 8
            },
            "sniffing": {
                "destOverride": [
                    "http",
                    "tls",
                    "fakedns"
                ],
                "enabled": true
            },
            "tag": "socks"
        },
        {
            "port": 10809,
            "protocol": "http",
            "settings": {
                "userLevel": 8
            },
            "tag": "http"
        }
    ],
    "log": {
        "loglevel": "warning"
    },
    "meta": null,
    "outbounds": [
        {
            "protocol": "vless",
            "settings": {
                "vnext": [
                    {
                        "address": "0.0.0.0",
                        "port": 1,
                        "users": [
                            {
                                "encryption": "none",
                                "flow": "",
                                "id": "00000000-0000-0000-0000-000000000000"
                            }
                        ]
                    }
                ]
            },
            "streamSettings": {
                "network": "tcp",
                "security": "none",
                "tcpSettings": {
                }
            },
            "tag": "proxy"
        },
        {
            "protocol": "freedom",
            "tag": "direct"
        },
        {
            "protocol": "blackhole",
            "tag": "block"
        }
    ],
    "policy": {
        "system": {
            "statsOutboundDownlink": true,
            "statsOutboundUplink": true
        }
    },
    "remarks": "🚨 Срок действия подписки истек",
    "routing": {
        "domainStrategy": "IPIfNonMatch",
        "rules": [
            {
                "domain": [
                    "domain:oneme.ru",
                    "domain:max.ru"
                ],
                "outboundTag": "block",
                "type": "field"
            },
            {
                "domain": [
                    "avito.st",
                    "geosite:category-ru",
                    "regexp:.*\\.ru$",
                    "regexp:.*\\.xn--p1ai$",
                    "regexp:.*\\.xn--p1acf$",
                    "regexp:.*\\.xn--p1ag$"
                ],
                "outboundTag": "direct",
                "type": "field"
            },
            {
                "domain": [
                    "geosite:private"
                ],
                "outboundTag": "direct",
                "type": "field"
            },
            {
                "ip": [
                    "geoip:ru",
                    "geoip:private"
                ],
                "outboundTag": "direct",
                "type": "field"
            }
        ]
    },
    "stats": {
    }
}`;

function generateRandomId() {
    return Math.random().toString(36).substring(2, 8);
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'vpn-admin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 часа
}));

// Проверка авторизации
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Страница входа
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Вход в админку VPN</title>
            <style>
                body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0d1117; color: #fff; margin: 0; }
                .login-card { background: #161b22; padding: 2rem; border-radius: 12px; width: 300px; }
                input { width: 100%; padding: 10px; margin: 10px 0; border-radius: 6px; border: none; background: #0d1117; color: #fff; border: 1px solid #333; }
                button { width: 100%; padding: 10px; background: #238636; color: white; border: none; border-radius: 6px; cursor: pointer; }
                .error { color: #f85149; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>🔐 Вход в админку VPN</h2>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <button type="submit">Войти</button>
                </form>
                ${req.query.error ? '<div class="error">Неверный логин или пароль</div>' : ''}
            </div>
        </body>
        </html>
    `);
});

// Обработчик входа
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === '123' && password === '123') {
        req.session.authenticated = true;
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

// Выход
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Главная страница — дашборд (только для админа)
app.get('/', isAuthenticated, (req, res) => {
    let linksHtml = '';
    for (const [id, data] of Object.entries(subscriptions)) {
        linksHtml += `
            <div style="margin: 10px 0; padding: 10px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <strong>📝 Содержимое:</strong> <span style="color: #58a6ff; word-break: break-all;">${data.content.substring(0, 50)}${data.content.length > 50 ? '...' : ''}</span><br>
                <code style="color: #0f0;">/p/${id}</code><br>
                👥 ${data.count} человек перешло
                <form action="/delete/${id}" method="POST" style="display: inline;">
                    <button type="submit" style="background: #d32f2f; color: white; border: none; padding: 5px 10px; border-radius: 4px;">🗑 Удалить</button>
                </form>
                <form action="/decrement/${id}" method="POST" style="display: inline;">
                    <button type="submit" style="background: #ff9800; color: white; border: none; padding: 5px 10px; border-radius: 4px;">➖ −1</button>
                </form>
                <form action="/destroy/${id}" method="POST" style="display: inline;">
                    <button type="submit" style="background: #8b0000; color: white; border: none; padding: 5px 10px; border-radius: 4px;">💀 Уничтожить</button>
                </form>
            </div>
        `;
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>VPN Подписка — Дашборд админа</title>
            <style>
                body { font-family: Arial; padding: 2rem; background: #0d1117; color: #fff; }
                .card { background: #161b22; padding: 1.5rem; border-radius: 12px; margin-bottom: 1rem; }
                input, button { padding: 10px; margin: 5px; border-radius: 6px; border: none; }
                input { width: 250px; background: #0d1117; color: #fff; border: 1px solid #333; }
                button { background: #238636; color: white; cursor: pointer; }
                code { background: #0d1117; padding: 4px 8px; border-radius: 4px; }
                .logout { background: #d32f2f; float: right; }
            </style>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 1rem;">
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
            </div>
            <div class="card">
                <h1>🔐 VPN Подписка — Создать ссылку</h1>
                <form action="/generate" method="POST">
                    <input type="text" name="content" placeholder="Введите содержимое ссылки (конфиг VPN)" required>
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

// Генерация новой ссылки (только для админа)
app.post('/generate', isAuthenticated, (req, res) => {
    let content = req.body.content;
    // Добавляем префикс, если его ещё нет
    if (!content.startsWith(PROFILE_PREFIX)) {
        content = PROFILE_PREFIX + content;
    }
    const randomId = generateRandomId();
    subscriptions[randomId] = { content: content, count: 0 };
    res.redirect('/');
});

// Переход по ссылке — доступно всем, показывает RAW текст с префиксом
app.get('/p/:id', (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].count++;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(subscriptions[id].content);
    } else {
        res.status(404).send('Link not found');
    }
});

// Удалить одного пользователя (только для админа)
app.post('/decrement/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].count > 0) {
        subscriptions[id].count--;
    }
    res.redirect('/');
});

// Полностью удалить ссылку (только для админа)
app.post('/delete/:id', isAuthenticated, (req, res) => {
    delete subscriptions[req.params.id];
    res.redirect('/');
});

// Уничтожить ссылку — заменить содержимое на DESTROY_CONFIG (только для админа)
app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        // Заменяем содержимое на JSON-конфиг с префиксом
        let newContent = PROFILE_PREFIX + DESTROY_CONFIG;
        subscriptions[id].content = newContent;
        // Счётчик НЕ сбрасываем
    }
    res.redirect('/');
});

// Запуск сервера
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
