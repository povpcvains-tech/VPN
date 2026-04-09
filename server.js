const express = require('express');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== КОНФИГУРАЦИЯ ====================
const GIST_ID = 'fe2b9abda4ee7cf16314d8422c97f933';
const GITHUB_TOKEN = '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';

// ==================== ПЕРЕМЕННЫЕ ====================
let subscriptions = {};
let users = {};
const BACKUP_FILE = './backup.json';
const USERS_FILE = './users.json';
const PROFILE_PREFIX = '# profile-update-interval: 1\n';
const DESTROY_CONFIG = 'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=random&pbk=00000000000000000000000000000000000000000000&sid=0000000000000000&type=tcp&headerType=none#VLESS_Reality_Example';

// Шаблоны подписок
const SUBSCRIPTION_TEMPLATES = {
    regular: {
        name: '⬇️ Обычный VPN',
        configs: [
            'vless://uuid@server:443?encryption=none&type=ws&host=example.com&path=/path#Regular_VPN',
            'trojan://pass@server:443?sni=example.com#Trojan_Regular'
        ]
    },
    lte: {
        name: '⬇️ LTE Сервера',
        configs: [
            'vless://uuid@lte-server:443?encryption=none&type=ws&host=lte.example.com&path=/lte#LTE_VPN',
            'ss://method:pass@lte-server:8388#Shadowsocks_LTE'
        ]
    },
    custom: {
        name: '📝 Свой текст',
        configs: []
    }
};

const upload = multer({ storage: multer.memoryStorage() });

// ==================== ЗАГРУЗКА ДАННЫХ ====================
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } else {
            // Создаём дефолтного админа + указанного пользователя
            const hashedPassword = bcrypt.hashSync('123', 10);
            const hashedBase64 = bcrypt.hashSync('5382197', 10);
            users = {
                'admin': {
                    username: 'admin',
                    password: hashedPassword,
                    createdAt: new Date().toISOString(),
                    role: 'admin',
                    blocked: false,
                    frozen: false,
                    linksCreated: 0
                },
                'base64': {
                    username: 'base64',
                    password: hashedBase64,
                    createdAt: new Date().toISOString(),
                    role: 'superadmin',
                    blocked: false,
                    frozen: false,
                    linksCreated: 0
                }
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
        
        // Миграция: добавляем новые поля старым пользователям
        let migrated = false;
        for (const username in users) {
            if (!users[username].role) {
                users[username].role = username === 'admin' ? 'admin' : 'user';
                migrated = true;
            }
            if (users[username].blocked === undefined) {
                users[username].blocked = false;
                users[username].frozen = false;
                users[username].linksCreated = 0;
                migrated = true;
            }
        }
        if (migrated) saveUsers();
        
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения пользователей:', error);
    }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function generateRandomId() {
    return Math.random().toString(36).substring(2, 8);
}

function addPrefix(content) {
    if (!content.startsWith(PROFILE_PREFIX)) {
        return PROFILE_PREFIX + content;
    }
    return content;
}

function removePrefix(content) {
    if (content.startsWith(PROFILE_PREFIX)) {
        return content.substring(PROFILE_PREFIX.length);
    }
    return content;
}

function replaceAddressInConfig(config, newAddress) {
    return config.replace(/@[\d\.]+:\d+/, `@${newAddress}`);
}

async function getCountryFromIP(ip) {
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}`);
        if (response.data.status === 'success') {
            return response.data.country;
        }
    } catch (error) {
        console.error('Ошибка определения страны:', error);
    }
    return 'Неизвестно';
}

// Вычисление даты истечения
function calculateExpiryDate(duration, unit) {
    const now = new Date();
    switch(unit) {
        case 'minutes': return new Date(now.getTime() + duration * 60 * 1000);
        case 'hours': return new Date(now.getTime() + duration * 60 * 60 * 1000);
        case 'days': return new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
        case 'months': return new Date(now.getFullYear(), now.getMonth() + duration, now.getDate());
        default: return new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
    }
}

// Проверка истечения подписки
function isSubscriptionExpired(sub) {
    if (!sub.expiryDate) return false;
    return new Date() > new Date(sub.expiryDate);
}

// Проверка лимита трафика
function isTrafficLimitExceeded(sub) {
    if (!sub.trafficLimit || sub.trafficLimit <= 0) return false;
    let totalTraffic = 0;
    if (sub.devices) {
        for (const device of Object.values(sub.devices)) {
            totalTraffic += (device.trafficUsed || 0);
        }
    }
    return totalTraffic >= sub.trafficLimit;
}

// Применение "уничтожения" подписки
function applyDestroyConfig(sub) {
    sub.masterConfig = addPrefix(DESTROY_CONFIG);
    sub.content = addPrefix(DESTROY_CONFIG);
    sub.isDestroyed = true;
    if (sub.devices) {
        for (const deviceId in sub.devices) {
            sub.devices[deviceId].active = false;
            sub.devices[deviceId].config = DESTROY_CONFIG;
        }
    }
}

// Обновление конфигов для всех устройств при изменении мастер-конфига
function updateAllDevicesConfig(subId) {
    const sub = subscriptions[subId];
    if (!sub || !sub.devices) return;
    
    for (const deviceId in sub.devices) {
        // Если устройство активно - обновляем конфиг, если нет - оставляем destroy
        if (sub.devices[deviceId].active && !sub.isDestroyed) {
            sub.devices[deviceId].config = sub.masterConfig;
        }
    }
}

// Проверка всех подписок на истечение/лимиты (запускается периодически)
function checkSubscriptions() {
    for (const [id, sub] of Object.entries(subscriptions)) {
        if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
            console.log(`🔥 Подписка ${id} истекла или превысила лимит - применяем destroy`);
            applyDestroyConfig(sub);
            sub.expiryNotificationSent = false; // сброс для возможности продления
        }
    }
    saveToGist();
}

// Запускаем проверку каждые 5 минут
setInterval(checkSubscriptions, 5 * 60 * 1000);

// ==================== РАБОТА С GIST ====================
async function saveToGist() {
    console.log('💾 Сохраняю в Gist...');
    
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: {
                    'DataBAse.json': {
                        content: JSON.stringify(subscriptions, null, 2)
                    }
                }
            })
        });
        
        if (response.ok) {
            console.log('✅ Данные сохранены в Gist');
        } else {
            const errorText = await response.text();
            console.log('❌ Ошибка API:', response.status, errorText);
            fs.writeFileSync(BACKUP_FILE, JSON.stringify(subscriptions, null, 2));
            console.log('📁 Сохранено в локальный бэкап');
        }
    } catch (error) {
        console.error('❌ Ошибка сохранения:', error.message);
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(subscriptions, null, 2));
        console.log('📁 Сохранено в локальный бэкап');
    }
}

async function loadFromGist() {
    console.log('📥 Загружаю из Gist...');
    
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`
            }
        });
        
        if (response.ok) {
            const gist = await response.json();
            const content = gist.files?.['DataBAse.json']?.content;
            
            if (content) {
                subscriptions = JSON.parse(content);
                const count = Object.keys(subscriptions).length;
                console.log(`✅ Загружено ${count} ссылок из Gist`);
                
                // Миграция старых данных + новые поля
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) data.masterConfig = data.content;
                    if (!data.devices) data.devices = {};
                    // Новые поля для версии 1.6
                    if (!data.name) data.name = `Подписка #${id}`;
                    if (!data.template) data.template = 'none';
                    if (!data.trafficLimit) data.trafficLimit = 0;
                    if (!data.expiryDate) data.expiryDate = null;
                    if (!data.isDestroyed) data.isDestroyed = false;
                    if (!data.expiryNotificationSent) data.expiryNotificationSent = false;
                    if (!data.owner) data.owner = 'admin';
                    // Миграция устройств: добавляем trafficUsed
                    if (data.devices) {
                        for (const devId in data.devices) {
                            if (data.devices[devId].trafficUsed === undefined) {
                                data.devices[devId].trafficUsed = 0;
                            }
                        }
                    }
                }
                
                return true;
            } else {
                console.log('⚠️ Файл DataBAse.json пуст');
                return false;
            }
        } else {
            console.log('❌ Ошибка загрузки:', response.status);
            
            if (fs.existsSync(BACKUP_FILE)) {
                const backupData = fs.readFileSync(BACKUP_FILE, 'utf8');
                subscriptions = JSON.parse(backupData);
                console.log(`📁 Загружено из локального бэкапа`);
                // Применяем миграцию и к локальным данным
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) data.masterConfig = data.content;
                    if (!data.devices) data.devices = {};
                    if (!data.name) data.name = `Подписка #${id}`;
                    if (!data.template) data.template = 'none';
                    if (!data.trafficLimit) data.trafficLimit = 0;
                    if (!data.expiryDate) data.expiryDate = null;
                    if (!data.isDestroyed) data.isDestroyed = false;
                }
                return true;
            }
            return false;
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки из Gist:', error.message);
        
        if (fs.existsSync(BACKUP_FILE)) {
            const backupData = fs.readFileSync(BACKUP_FILE, 'utf8');
            subscriptions = JSON.parse(backupData);
            console.log(`📁 Загружено из локального бэкапа`);
            return true;
        }
        return false;
    }
}

// ==================== MIDDLEWARE ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'vpn-secret-key-2024-v1.6',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated && req.session.userId && users[req.session.userId]) {
        const user = users[req.session.userId];
        if (user.blocked || user.frozen) {
            req.session.destroy();
            return res.redirect('/login?error=blocked');
        }
        next();
    } else {
        res.redirect('/login');
    }
}

function isAdmin(req, res, next) {
    if (users[req.session.userId]?.role === 'admin' || users[req.session.userId]?.role === 'superadmin') {
        next();
    } else {
        res.status(403).send('Доступ запрещён');
    }
}

// ==================== СТРАНИЦА РЕГИСТРАЦИИ ====================
app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Регистрация</title>
            <style>
                body { font-family: Arial; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; margin: 0; }
                .container { background: white; border-radius: 16px; padding: 40px; width: 450px; max-width: 90%; }
                h1 { text-align: center; color: #333; margin-bottom: 20px; }
                input, button { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; box-sizing: border-box; }
                button { background: #667eea; color: white; border: none; cursor: pointer; font-weight: bold; }
                button:hover { background: #5a67d8; }
                .link { text-align: center; margin-top: 15px; }
                .link a { color: #667eea; text-decoration: none; }
                .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 10px; border-radius: 8px; margin-bottom: 15px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📝 Регистрация</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                <form action="/register" method="POST" onsubmit="event.preventDefault(); this.submit();">
                    <input type="text" name="username" placeholder="Логин" required minlength="3" maxlength="20">
                    <input type="password" name="password" placeholder="Пароль" required minlength="6">
                    <input type="password" name="confirm_password" placeholder="Подтвердите пароль" required>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <div class="link">
                    <a href="/login">← Вернуться ко входу</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password, confirm_password } = req.body;
    
    if (password !== confirm_password) {
        return res.redirect('/register?error=Пароли не совпадают');
    }
    
    if (users[username]) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    if (username.length < 3 || password.length < 6) {
        return res.redirect('/register?error=Логин минимум 3 символа, пароль минимум 6');
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    users[username] = {
        username: username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        role: 'user',
        blocked: false,
        frozen: false,
        linksCreated: 0
    };
    
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== СТРАНИЦА ВХОДА ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'no_file' ? '❌ Файл не выбран' : 
                  req.query.error === 'invalid' ? '❌ Неверный формат файла' : 
                  req.query.error === 'auth' ? '❌ Неверный логин или пароль' :
                  req.query.error === 'blocked' ? '🚫 Аккаунт заблокирован' : '';
    const registered = req.query.registered === 'true' ? '✅ Регистрация успешна! Войдите.' : '';
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>VPN Админка - Вход</title>
            <style>
                body { font-family: Arial; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; margin: 0; }
                .container { background: white; border-radius: 16px; padding: 40px; width: 450px; max-width: 90%; }
                h1 { text-align: center; color: #333; margin-bottom: 20px; }
                h2 { font-size: 18px; color: #555; margin: 20px 0 10px; }
                input, button { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; box-sizing: border-box; }
                button { background: #667eea; color: white; border: none; cursor: pointer; font-weight: bold; }
                button:hover { background: #5a67d8; }
                .divider { text-align: center; margin: 20px 0; color: #999; }
                .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 8px; margin: 15px 0; font-size: 13px; color: #856404; }
                .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
                .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
                .link { text-align: center; margin-top: 15px; }
                .link a { color: #667eea; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 VPN Админка</h1>
                ${error ? `<div class="warning error">${error}</div>` : ''}
                ${registered ? `<div class="warning success">${registered}</div>` : ''}
                
                <h2>🔑 Вход</h2>
                <form action="/login" method="POST" onsubmit="event.preventDefault(); this.submit();">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <button type="submit">Войти</button>
                </form>
                
                <div class="link">
                    <a href="/register">📝 Регистрация</a>
                </div>
                
                <div class="divider">━━━━━━ ИЛИ ━━━━━━</div>
                
                <h2>📂 Восстановление</h2>
                <form action="/restore-from-file" method="POST" enctype="multipart/form-data" onsubmit="event.preventDefault(); this.submit();">
                    <input type="file" name="backupFile" accept=".txt" required>
                    <button type="submit">📂 Загрузить из .txt файла</button>
                </form>
                
                <form action="/restore-from-gist" method="POST" onsubmit="event.preventDefault(); this.submit();">
                    <button type="submit" style="background: #28a745;">☁️ Загрузить из Gist</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (users[username] && bcrypt.compareSync(password, users[username].password)) {
        const user = users[username];
        if (user.blocked) {
            return res.redirect('/login?error=blocked');
        }
        req.session.authenticated = true;
        req.session.userId = username;
        res.redirect('/');
    } else {
        res.redirect('/login?error=auth');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==================== СМЕНА ПАРОЛЯ ====================
app.get('/change-password', isAuthenticated, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Смена пароля</title>
            <style>
                body { font-family: Arial; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; margin: 0; }
                .container { background: white; border-radius: 16px; padding: 40px; width: 450px; max-width: 90%; }
                h1 { text-align: center; color: #333; margin-bottom: 20px; }
                input, button { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; box-sizing: border-box; }
                button { background: #667eea; color: white; border: none; cursor: pointer; font-weight: bold; }
                button:hover { background: #5a67d8; }
                .link { text-align: center; margin-top: 15px; }
                .link a { color: #667eea; text-decoration: none; }
                .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 10px; border-radius: 8px; margin-bottom: 15px; }
                .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 10px; border-radius: 8px; margin-bottom: 15px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 Смена пароля</h1>
                <div id="message"></div>
                <form id="changeForm" onsubmit="event.preventDefault(); changePassword();">
                    <input type="password" id="current" placeholder="Текущий пароль" required>
                    <input type="password" id="newpass" placeholder="Новый пароль" required minlength="6">
                    <input type="password" id="confirm" placeholder="Подтвердите новый пароль" required>
                    <button type="submit">💾 Сохранить новый пароль</button>
                </form>
                <div class="link">
                    <a href="/">← Назад в панель</a>
                </div>
            </div>
            <script>
                async function changePassword() {
                    const current = document.getElementById('current').value;
                    const newpass = document.getElementById('newpass').value;
                    const confirm = document.getElementById('confirm').value;
                    const msg = document.getElementById('message');
                    
                    if (newpass !== confirm) {
                        msg.innerHTML = '<div class="error">❌ Пароли не совпадают</div>';
                        return;
                    }
                    if (newpass.length < 6) {
                        msg.innerHTML = '<div class="error">❌ Пароль минимум 6 символов</div>';
                        return;
                    }
                    
                    try {
                        const res = await fetch('/api/change-password', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({current, newpass})
                        });
                        const data = await res.json();
                        if (data.success) {
                            msg.innerHTML = '<div class="success">✅ Пароль изменён! Перенаправляем...</div>';
                            setTimeout(() => window.location.href = '/', 2000);
                        } else {
                            msg.innerHTML = '<div class="error">❌ ' + (data.error || 'Ошибка') + '</div>';
                        }
                    } catch(e) {
                        msg.innerHTML = '<div class="error">❌ Ошибка сети</div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/api/change-password', isAuthenticated, express.json(), (req, res) => {
    const { current, newpass } = req.body;
    const user = users[req.session.userId];
    
    if (!bcrypt.compareSync(current, user.password)) {
        return res.json({success: false, error: 'Неверный текущий пароль'});
    }
    
    user.password = bcrypt.hashSync(newpass, 10);
    saveUsers();
    res.json({success: true});
});

// ==================== ВОССТАНОВЛЕНИЕ ====================
app.post('/restore-from-file', upload.single('backupFile'), (req, res) => {
    try {
        if (!req.file) return res.redirect('/login?error=no_file');
        
        const fileContent = req.file.buffer.toString('utf-8');
        const base64Match = fileContent.match(/\[ДАННЫЕ В BASE64\]\n([A-Za-z0-9+/=]+)/);
        
        if (base64Match) {
            const jsonString = Buffer.from(base64Match[1], 'base64').toString('utf-8');
            const exportData = JSON.parse(jsonString);
            subscriptions = exportData.subscriptions;
            // Миграция при восстановлении
            for (const [id, data] of Object.entries(subscriptions)) {
                if (!data.masterConfig && data.content) data.masterConfig = data.content;
                if (!data.devices) data.devices = {};
                if (!data.name) data.name = `Подписка #${id}`;
                if (!data.trafficLimit) data.trafficLimit = 0;
            }
            saveToGist();
            console.log(`✅ Восстановлено ${Object.keys(subscriptions).length} ссылок из файла`);
        } else {
            return res.redirect('/login?error=invalid');
        }
    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        return res.redirect('/login?error=invalid');
    }
    res.redirect('/login');
});

app.post('/restore-from-gist', async (req, res) => {
    await loadFromGist();
    res.redirect('/login');
});

// ==================== ЭКСПОРТ ====================
app.get('/export-all', isAuthenticated, (req, res) => {
    const exportData = {
        version: '1.6',
        exportDate: new Date().toISOString(),
        totalLinks: Object.keys(subscriptions).length,
        subscriptions: subscriptions
    };
    
    const jsonString = JSON.stringify(exportData, null, 2);
    const base64Data = Buffer.from(jsonString).toString('base64');
    
    const fileContent = `VPN SUBSCRIPTIONS BACKUP v1.6
========================
Экспорт: ${new Date().toLocaleString()}
Ссылок: ${Object.keys(subscriptions).length}
========================

[ДАННЫЕ В BASE64]
${base64Data}

========================
ВОССТАНОВЛЕНИЕ: на странице входа → "Загрузить из .txt файла"
========================
`;
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=vpn-backup-${Date.now()}.txt`);
    res.send(fileContent);
});

// ==================== ГЕНЕРАЦИЯ QR-КОДА С НОВЫМ UUID ====================
app.get('/generate-qrcode/:id', isAuthenticated, async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        const newDeviceId = uuidv4();
        const url = `${req.protocol}://${req.get('host')}/p/${id}?deviceId=${newDeviceId}`;
        
        try {
            const qrCode = await QRCode.toDataURL(url);
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>QR Code - ${id}</title>
                    <style>
                        body { font-family: Arial; background: #0d1117; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                        .container { background: #161b22; padding: 30px; border-radius: 12px; text-align: center; }
                        img { background: white; padding: 10px; border-radius: 8px; }
                        button { margin-top: 20px; padding: 10px 20px; background: #238636; color: white; border: none; border-radius: 6px; cursor: pointer; }
                        button:hover { background: #2ea043; }
                        .info { margin: 10px 0; color: #58a6ff; font-size: 12px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>🔗 QR-код с новым устройством</h2>
                        <img src="${qrCode}" alt="QR Code">
                        <div class="info">UUID: ${newDeviceId}</div>
                        <button onclick="window.close()">Закрыть</button>
                    </div>
                </body>
                </html>
            `);
        } catch (error) {
            res.status(500).send('Ошибка генерации QR-кода');
        }
    } else {
        res.status(404).send('Ссылка не найдена');
    }
});

// ==================== УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ (для админов) ====================
app.get('/admin/users', isAuthenticated, isAdmin, (req, res) => {
    let usersHtml = '';
    for (const [username, user] of Object.entries(users)) {
        const linksCount = Object.values(subscriptions).filter(s => s.owner === username).length;
        usersHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px;">
                    <strong>👤 ${escapeHtml(username)}</strong> 
                    ${user.role === 'superadmin' ? '<span style="color:gold;">⭐ SUPERADMIN</span>' : ''}
                    ${user.role === 'admin' ? '<span style="color:#58a6ff;">🔷 ADMIN</span>' : ''}
                    ${user.blocked ? '<span style="color:red;">🚫 Заблокирован</span>' : ''}
                    ${user.frozen ? '<span style="color:orange;">❄️ Заморожен</span>' : ''}
                </div>
                <div style="font-size:13px; color:#8b949e; margin-bottom:10px;">
                    📧 Создан: ${new Date(user.createdAt).toLocaleDateString()}<br>
                    🔗 Ссылок создано: ${linksCount}<br>
                    🌐 IP при входе: ${user.lastIP || '—'}
                </div>
                <div>
                    <button onclick="viewUserContent('${username}')" style="background:#1f6392;">👁 Смотреть содержимое</button>
                    <button onclick="enterUserProfile('${username}')" style="background:#6f42c1;">👤 Зайти в профиль</button>
                    <button onclick="warnUser('${username}')" style="background:#d29922;">⚠ Предупредить</button>
                    ${user.blocked ? 
                        `<button onclick="unblockUser('${username}')" style="background:#238636;">✅ Разблокировать</button>` : 
                        `<button onclick="blockUser('${username}')" style="background:#8b0000;">🔒 Заблокировать</button>`
                    }
                    ${user.frozen ? 
                        `<button onclick="unfreezeUser('${username}')" style="background:#238636;">🔓 Разморозить</button>` : 
                        `<button onclick="freezeUser('${username}')" style="background:#8b4513;">❄️ Заморозить</button>`
                    }
                    <button onclick="deleteUser('${username}')" style="background:#d32f2f;">🗑 Удалить профиль</button>
                </div>
            </div>
        `;
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Управление пользователями</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #0d1117; color: #fff; }
                .card { background: #161b22; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
                button { padding: 8px 12px; margin: 5px; border-radius: 6px; border: none; cursor: pointer; }
                .back { background: #6e7681; color: white; }
                .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
                .modal-content { background: #161b22; margin: 50px auto; padding: 20px; width: 80%; max-width: 500px; border-radius: 12px; }
                .close { color: #fff; float: right; font-size: 28px; cursor: pointer; }
                input, textarea, select { padding: 10px; width: 100%; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; margin: 5px 0; }
            </style>
        </head>
        <body>
            <div style="overflow:hidden;margin-bottom:20px;">
                <span style="font-size:18px;">👮 Админ-панель</span>
                <a href="/"><button class="back" style="float:right;">← Назад</button></a>
            </div>
            <div class="card">
                <h2>👥 Зарегистрировано пользователей: ${Object.keys(users).length}</h2>
                ${usersHtml}
            </div>
            
            <div id="modal" class="modal">
                <div class="modal-content">
                    <span class="close" onclick="closeModal()">&times;</span>
                    <div id="modalContent"></div>
                </div>
            </div>
            
            <script>
                function closeModal() { document.getElementById('modal').style.display = 'none'; }
                
                function viewUserContent(username) {
                    fetch('/api/user-content/' + username)
                        .then(r => r.json())
                        .then(data => {
                            let html = '<h3>📦 Содержимое пользователя: ' + username + '</h3>';
                            if (data.links.length === 0) html += '<p>Нет созданных ссылок</p>';
                            else {
                                for (const [id, sub] of Object.entries(data.links)) {
                                    html += '<div style="background:#0d1117;padding:10px;margin:5px 0;border-radius:6px;">';
                                    html += '<strong>' + escapeHtml(sub.name || id) + '</strong><br>';
                                    html += '<small>' + escapeHtml((sub.masterConfig||'').substring(0,100)) + '...</small>';
                                    html += '</div>';
                                }
                            }
                            document.getElementById('modalContent').innerHTML = html;
                            document.getElementById('modal').style.display = 'block';
                        });
                }
                
                function enterUserProfile(username) {
                    alert('Функция входа в профиль пользователя: ' + username + '\\n(В разработке)');
                }
                
                function warnUser(username) {
                    const reason = prompt('Введите текст предупреждения для ' + username + ':');
                    if (reason) {
                        fetch('/api/warn-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username, reason})
                        }).then(() => location.reload());
                    }
                }
                
                function blockUser(username) {
                    const time = prompt('На сколько заблокировать? (часы/дни/навсегда):', 'навсегда');
                    const reason = prompt('Причина блокировки:');
                    if (time && reason) {
                        fetch('/api/block-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username, time, reason})
                        }).then(() => location.reload());
                    }
                }
                
                function unblockUser(username) {
                    if (confirm('Разблокировать ' + username + '?')) {
                        fetch('/api/unblock-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username})
                        }).then(() => location.reload());
                    }
                }
                
                function freezeUser(username) {
                    const time = prompt('На сколько заморозить? (часы/дни):', '24 часа');
                    const reason = prompt('Причина заморозки:');
                    if (time && reason) {
                        fetch('/api/freeze-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username, time, reason})
                        }).then(() => location.reload());
                    }
                }
                
                function unfreezeUser(username) {
                    if (confirm('Разморозить ' + username + '?')) {
                        fetch('/api/unfreeze-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username})
                        }).then(() => location.reload());
                    }
                }
                
                function deleteUser(username) {
                    if (confirm('⚠️ УДАЛИТЬ профиль ' + username + ' навсегда?\\nВсе его ссылки будут удалены!')) {
                        fetch('/api/delete-user', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({username})
                        }).then(() => location.reload());
                    }
                }
                
                function escapeHtml(text) {
                    if (!text) return '';
                    return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
                }
            </script>
        </body>
        </html>
    `);
});

// API для управления пользователями
app.post('/api/warn-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username, reason } = req.body;
    console.log(`⚠️ Предупреждение для ${username}: ${reason}`);
    // Здесь можно добавить отправку уведомления пользователю
    res.json({success: true});
});

app.post('/api/block-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username, time, reason } = req.body;
    if (users[username] && username !== req.session.userId) {
        users[username].blocked = true;
        users[username].blockReason = reason;
        users[username].blockTime = time;
        users[username].blockedAt = new Date().toISOString();
        saveUsers();
        console.log(`🔒 Заблокирован ${username}: ${reason} (${time})`);
    }
    res.json({success: true});
});

app.post('/api/unblock-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username } = req.body;
    if (users[username]) {
        users[username].blocked = false;
        delete users[username].blockReason;
        delete users[username].blockTime;
        saveUsers();
    }
    res.json({success: true});
});

app.post('/api/freeze-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username, time, reason } = req.body;
    if (users[username] && username !== req.session.userId) {
        users[username].frozen = true;
        users[username].freezeReason = reason;
        users[username].freezeTime = time;
        users[username].frozenAt = new Date().toISOString();
        // Автоматическая разморозка через заданное время (упрощённо)
        saveUsers();
        console.log(`❄️ Заморожен ${username}: ${reason} (${time})`);
    }
    res.json({success: true});
});

app.post('/api/unfreeze-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username } = req.body;
    if (users[username]) {
        users[username].frozen = false;
        delete users[username].freezeReason;
        delete users[username].freezeTime;
        saveUsers();
    }
    res.json({success: true});
});

app.post('/api/delete-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username } = req.body;
    if (username && username !== req.session.userId && users[username]) {
        // Удаляем все ссылки пользователя
        for (const [id, sub] of Object.entries(subscriptions)) {
            if (sub.owner === username) {
                delete subscriptions[id];
            }
        }
        // Удаляем пользователя
        delete users[username];
        saveUsers();
        saveToGist();
        console.log(`🗑 Удалён пользователь ${username}`);
    }
    res.json({success: true});
});

app.get('/api/user-content/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    const userLinks = {};
    for (const [id, sub] of Object.entries(subscriptions)) {
        if (sub.owner === username) {
            userLinks[id] = { name: sub.name, masterConfig: sub.masterConfig };
        }
    }
    res.json({ username, links: userLinks });
});

// ==================== ДАШБОРД ====================
app.get('/', isAuthenticated, (req, res) => {
    const currentUser = users[req.session.userId];
    const isSuperAdmin = currentUser?.role === 'superadmin';
    
    let linksHtml = '';
    const linksCount = Object.keys(subscriptions).length;
    
    for (const [id, data] of Object.entries(subscriptions)) {
        // Фильтр: обычные пользователи видят только свои ссылки, админы - все
        if (!isSuperAdmin && data.owner !== req.session.userId) continue;
        
        const shortContent = removePrefix(data.masterConfig || data.content || '').substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.masterConfig || data.content || '').length > 50 ? '...' : '');
        const devicesCount = data.devices ? Object.keys(data.devices).length : 0;
        
        // Статус подписки
        let statusBadge = '';
        if (data.isDestroyed) {
            statusBadge = '<span style="color:#d32f2f;">💀 УНИЧТОЖЕНА</span>';
        } else if (isSubscriptionExpired(data)) {
            statusBadge = '<span style="color:#d32f2f;">⏰ ИСТЕКЛА</span>';
        } else if (isTrafficLimitExceeded(data)) {
            statusBadge = '<span style="color:#d32f2f;">📊 ЛИМИТ ИСЧЕРПАН</span>';
        } else if (data.expiryDate) {
            const daysLeft = Math.ceil((new Date(data.expiryDate) - new Date()) / (1000*60*60*24));
            statusBadge = `<span style="color:#238636;">⏳ Осталось: ${daysLeft} дн.</span>`;
        }
        
        linksHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <code style="color: #0f0; font-size: 16px;">🔗 /p/${id}</code>
                        <span style="margin-left:10px; color:#8b949e; font-size:13px;">${escapeHtml(data.name || 'Без названия')}</span>
                    </div>
                    ${statusBadge}
                </div>
                <div style="margin-bottom: 8px; color: #58a6ff;">📝 ${escapeHtml(displayContent)}</div>
                <div style="margin-bottom: 12px; font-size:13px;">
                    👥 ${data.count || 0} переходов | 
                    📱 ${devicesCount} устройств | 
                    🌐 Трафик: ${data.trafficLimit ? (Object.values(data.devices||{}).reduce((s,d)=>s+(d.trafficUsed||0),0) / data.trafficLimit * 100).toFixed(1) + '%' : '∞'}
                    ${data.expiryDate ? ' | ⏰ До: ' + new Date(data.expiryDate).toLocaleDateString() : ''}
                </div>
                <div>
                    <button onclick="copyWithNewDevice('${id}')" style="background: #1f6392;">📋 Копировать (новое устр-во)</button>
                    <button onclick="window.open('/generate-qrcode/${id}', '_blank', 'width=400,height=500')" style="background: #ff9800;">📱 QR-код</button>
                    <button onclick="editLink('${id}')" style="background: #1f6392;">✏️ Изменить</button>
                    <button onclick="showDevices('${id}')" style="background: #6f42c1;">📱 Устройства</button>
                    ${!data.isDestroyed ? `
                        <button onclick="extendSubscription('${id}')" style="background: #238636;">💰 Оплатил? Продлить</button>
                    ` : ''}
                    ${data.originalContent ? `
                    <form action="/restore/${id}" method="POST" style="display: inline;" onsubmit="event.preventDefault(); this.submit();">
                        <button type="submit" style="background: #238636;">🔄 Восстановить</button>
                    </form>
                    ` : ''}
                    <form action="/delete/${id}" method="POST" style="display: inline;" onsubmit="event.preventDefault(); if(confirm('Удалить навсегда?')) this.submit();">
                        <button type="submit" style="background: #d32f2f;">🗑 Удалить</button>
                    </form>
                </div>
            </div>
        `;
    }
    
    // Генерация опций шаблонов
    let templateOptions = '';
    for (const [key, tpl] of Object.entries(SUBSCRIPTION_TEMPLATES)) {
        templateOptions += `<option value="${key}">${tpl.name}</option>`;
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>VPN Админка</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #0d1117; color: #fff; }
                .card { background: #161b22; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
                button { padding: 8px 12px; margin: 5px; border-radius: 6px; border: none; cursor: pointer; }
                input, textarea, select { padding: 10px; width: 100%; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; margin: 5px 0; }
                .generate { background: #238636; color: white; }
                .export { background: #1f6392; color: white; }
                .logout { background: #d32f2f; float: right; }
                .admin-link { background: #8b4513; color: white; float: right; margin-right: 10px; }
                .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
                .modal-content { background: #161b22; margin: 50px auto; padding: 20px; width: 80%; max-width: 600px; border-radius: 12px; max-height: 80vh; overflow-y: auto; }
                .close { color: #fff; float: right; font-size: 28px; cursor: pointer; }
                .device-item { padding: 10px; margin: 5px 0; background: #0d1117; border-radius: 6px; }
                .device-active { border-left: 4px solid #238636; }
                .device-inactive { border-left: 4px solid #d32f2f; opacity: 0.7; }
                .tab { overflow: hidden; border: 1px solid #333; background: #0d1117; border-radius: 6px 6px 0 0; }
                .tab button { background: inherit; color: #8b949e; float: left; border: none; outline: none; cursor: pointer; padding: 12px 16px; transition: 0.3s; }
                .tab button:hover { background: #161b22; }
                .tab button.active { background: #1f6392; color: white; }
                .tabcontent { display: none; padding: 15px; border: 1px solid #333; border-top: none; background: #0d1117; border-radius: 0 0 6px 6px; }
            </style>
            <script>
                function copyWithNewDevice(id) {
                    const newDeviceId = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });
                    const url = window.location.origin + '/p/' + id + '?deviceId=' + newDeviceId;
                    navigator.clipboard.writeText(url);
                    alert('✅ Ссылка скопирована с новым устройством!\\nUUID: ' + newDeviceId);
                }
                
                function editLink(id) {
                    const newContent = prompt('Введите новый конфиг:', '');
                    if (newContent) {
                        fetch('/edit/' + id, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({content: newContent})
                        }).then(() => location.reload());
                    }
                }
                
                function extendSubscription(id) {
                    const html = \`
                        <h3>💰 Продление подписки</h3>
                        <p>На сколько продлить?</p>
                        <select id="extUnit">
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days" selected>Дни</option>
                            <option value="months">Месяцы</option>
                        </select>
                        <input type="number" id="extValue" value="30" min="1" placeholder="Количество">
                        <button onclick="submitExtension('\${id})" style="margin-top:10px;background:#238636;">✅ Продлить</button>
                    \`;
                    showModal(html);
                }
                
                function submitExtension(id) {
                    const unit = document.getElementById('extUnit').value;
                    const value = parseInt(document.getElementById('extValue').value);
                    if (value > 0) {
                        fetch('/api/extend/' + id, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({duration: value, unit: unit})
                        }).then(() => {
                            closeModal();
                            location.reload();
                        });
                    }
                }
                
                function showDevices(id) {
                    fetch('/devices/' + id)
                        .then(r => r.json())
                        .then(devices => {
                            let html = '<h2>📱 Устройства</h2>';
                            if (Object.keys(devices).length === 0) {
                                html += '<p>Нет подключенных устройств</p>';
                            } else {
                                for (const [uuid, device] of Object.entries(devices)) {
                                    html += \`
                                        <div class="device-item \${device.active ? 'device-active' : 'device-inactive'}">
                                            <strong>\${escapeHtml(device.name)}</strong><br>
                                            IP: \${escapeHtml(device.ip)}<br>
                                            UUID: \${uuid.substring(0,8)}...<br>
                                            🌍 Страна: \${escapeHtml(device.country || '—')}<br>
                                            📊 Трафик: \${(device.trafficUsed/1024/1024).toFixed(2)} МБ<br>
                                            Первый вход: \${new Date(device.firstSeen).toLocaleString()}<br>
                                            Последняя активность: \${new Date(device.lastSeen).toLocaleString()}<br>
                                            Статус: \${device.active ? '✅ Активно' : '❌ Неактивно'}<br>
                                            \${device.active ? \`
                                                <button onclick="deactivateDevice('\${id}', '\${uuid}')" style="background: #d32f2f; margin-top: 5px;">
                                                    ➖ Деактивировать
                                                </button>
                                            \` : \`
                                                <button onclick="restoreDevice('\${id}', '\${uuid}')" style="background: #238636; margin-top: 5px;">
                                                    🔄 Восстановить
                                                </button>
                                            \`}
                                        </div>
                                    \`;
                                }
                            }
                            html += '<br><button onclick="closeModal()">Закрыть</button>';
                            showModal(html);
                        });
                }
                
                function deactivateDevice(linkId, deviceId) {
                    if (confirm('Деактивировать устройство? Конфиг будет изменен на нерабочий.')) {
                        fetch('/deactivate-device/' + linkId + '/' + deviceId, { method: 'POST' })
                            .then(() => showDevices(linkId));
                    }
                }
                
                function restoreDevice(linkId, deviceId) {
                    if (confirm('Восстановить устройство?')) {
                        fetch('/restore-device/' + linkId + '/' + deviceId, { method: 'POST' })
                            .then(() => showDevices(linkId));
                    }
                }
                
                function showModal(content) {
                    document.getElementById('modalContent').innerHTML = content;
                    document.getElementById('modal').style.display = 'block';
                }
                
                function closeModal() {
                    document.getElementById('modal').style.display = 'none';
                }
                
                function openTab(evt, tabName) {
                    var i, tabcontent, tablinks;
                    tabcontent = document.getElementsByClassName("tabcontent");
                    for (i = 0; i < tabcontent.length; i++) tabcontent[i].style.display = "none";
                    tablinks = document.getElementsByClassName("tablink");
                    for (i = 0; i < tablinks.length; i++) tablinks[i].className = tablinks[i].className.replace(" active", "");
                    document.getElementById(tabName).style.display = "block";
                    evt.currentTarget.className += " active";
                }
                
                function escapeHtml(text) {
                    if (!text) return '';
                    return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
                }
            </script>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 20px;">
                <span style="font-size: 18px;">👤 ${req.session.userId} ${isSuperAdmin ? '⭐' : ''}</span>
                <a href="/change-password"><button style="background:#8b4513;float:right;margin-right:10px;">🔑 Сменить пароль</button></a>
                ${isSuperAdmin ? `<a href="/admin/users"><button class="admin-link">👥 Пользователи</button></a>` : ''}
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
                <a href="/export-all"><button class="export">💾 Скачать все ссылки</button></a>
            </div>
            
            <div class="card">
                <h1>✨ Создать подписку</h1>
                
                <div class="tab">
                    <button class="tablink active" onclick="openTab(event, 'simple')">🔹 Без шаблона</button>
                    <button class="tablink" onclick="openTab(event, 'template')">📋 Свой шаблон</button>
                </div>
                
                <div id="simple" class="tabcontent" style="display:block;">
                    <form action="/generate" method="POST" onsubmit="event.preventDefault(); this.submit();">
                        <input type="hidden" name="mode" value="simple">
                        <input type="text" name="name" placeholder="Название подписки (необязательно)" style="margin-bottom:10px;">
                        <textarea name="content" placeholder="Введите конфиг VPN" rows="4" required></textarea>
                        
                        <div style="margin:10px 0; padding:10px; background:#0d1117; border-radius:6px;">
                            <strong>⏱ Срок действия:</strong><br>
                            <input type="number" name="duration" value="30" min="1" style="width:80px;"> 
                            <select name="unit" style="width:120px;">
                                <option value="minutes">Минут</option>
                                <option value="hours">Часов</option>
                                <option value="days" selected>Дней</option>
                                <option value="months">Месяцев</option>
                            </select>
                        </div>
                        
                        <div style="margin:10px 0; padding:10px; background:#0d1117; border-radius:6px;">
                            <strong>📊 Лимит трафика (МБ):</strong><br>
                            <input type="number" name="trafficLimit" value="0" min="0" placeholder="0 = без лимита">
                            <small style="color:#8b949e;">При достижении лимита подписка автоматически деактивируется</small>
                        </div>
                        
                        <button type="submit" class="generate">✨ Сгенерировать</button>
                    </form>
                </div>
                
                <div id="template" class="tabcontent">
                    <form action="/generate" method="POST" onsubmit="event.preventDefault(); this.submit();">
                        <input type="hidden" name="mode" value="template">
                        <input type="text" name="name" placeholder="Название подписки" required style="margin-bottom:10px;">
                        
                        <label>📁 Выберите категорию:</label>
                        <select name="template" id="templateSelect" onchange="updateTemplateConfig()">
                            ${templateOptions}
                        </select>
                        
                        <label>🔗 Выберите конфигурацию:</label>
                        <select name="config" id="configSelect" onchange="fillConfig()">
                            <option value="">-- Выберите --</option>
                        </select>
                        
                        <textarea name="content" id="templateContent" placeholder="Конфиг появится здесь..." rows="4" required></textarea>
                        
                        <div style="margin:10px 0; padding:10px; background:#0d1117; border-radius:6px;">
                            <strong>⏱ Срок действия:</strong><br>
                            <input type="number" name="duration" value="30" min="1" style="width:80px;"> 
                            <select name="unit" style="width:120px;">
                                <option value="minutes">Минут</option>
                                <option value="hours">Часов</option>
                                <option value="days" selected>Дней</option>
                                <option value="months">Месяцев</option>
                            </select>
                        </div>
                        
                        <div style="margin:10px 0; padding:10px; background:#0d1117; border-radius:6px;">
                            <strong>📊 Лимит трафика (МБ):</strong><br>
                            <input type="number" name="trafficLimit" value="0" min="0" placeholder="0 = без лимита">
                        </div>
                        
                        <button type="submit" class="generate">✨ Сгенерировать из шаблона</button>
                    </form>
                </div>
            </div>
            
            <div class="card">
                <h2>📋 Мои подписки (${linksCount})</h2>
                ${linksHtml || '<p>Нет подписок. Создайте первую!</p>'}
            </div>
            
            <div id="modal" class="modal">
                <div class="modal-content">
                    <span class="close" onclick="closeModal()">&times;</span>
                    <div id="modalContent"></div>
                </div>
            </div>
            
            <script>
                // Инициализация шаблонов
                const templates = ${JSON.stringify(SUBSCRIPTION_TEMPLATES)};
                
                function updateTemplateConfig() {
                    const tplKey = document.getElementById('templateSelect').value;
                    const configSelect = document.getElementById('configSelect');
                    configSelect.innerHTML = '<option value="">-- Выберите --</option>';
                    
                    if (templates[tplKey] && templates[tplKey].configs) {
                        templates[tplKey].configs.forEach((cfg, idx) => {
                            const opt = document.createElement('option');
                            opt.value = cfg;
                            opt.textContent = (tplKey === 'custom' ? 'Конфиг #' : '') + (idx + 1);
                            configSelect.appendChild(opt);
                        });
                    }
                }
                
                function fillConfig() {
                    const cfg = document.getElementById('configSelect').value;
                    if (cfg) document.getElementById('templateContent').value = cfg;
                }
                
                // Открыть первую вкладку по умолчанию
                document.getElementsByClassName('tablink')[0].click();
            </script>
        </body>
        </html>
    `);
});

// ==================== ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    const id = generateRandomId();
    const mode = req.body.mode || 'simple';
    const duration = parseInt(req.body.duration) || 30;
    const unit = req.body.unit || 'days';
    const trafficLimit = parseInt(req.body.trafficLimit) || 0;
    
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content),
        content: addPrefix(req.body.content),
        originalContent: null,
        count: 0,
        devices: {},
        owner: req.session.userId,
        name: req.body.name || `Подписка #${id}`,
        template: mode === 'template' ? req.body.template : 'none',
        trafficLimit: trafficLimit > 0 ? trafficLimit * 1024 * 1024 : 0, // переводим МБ в байты
        expiryDate: calculateExpiryDate(duration, unit).toISOString(),
        isDestroyed: false,
        createdAt: new Date().toISOString()
    };
    
    // Увеличиваем счётчик ссылок у пользователя
    if (users[req.session.userId]) {
        users[req.session.userId].linksCreated = (users[req.session.userId].linksCreated || 0) + 1;
        saveUsers();
    }
    
    saveToGist();
    res.redirect('/');
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        // 🔥 ВАЖНО: обновляем конфиги для всех активных устройств
        updateAllDevicesConfig(id);
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        res.json(subscriptions[id].devices || {});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
        const device = subscriptions[linkId].devices[deviceId];
        device.active = false;
        device.name = device.name.replace(': Неактивно', '').trim() + ': Неактивно';
        device.config = replaceAddressInConfig(device.config, '0.0.0.0:443');
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/restore-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
        const device = subscriptions[linkId].devices[deviceId];
        device.active = true;
        device.name = device.name.replace(': Неактивно', '').trim();
        device.config = subscriptions[linkId].masterConfig;
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

// API для продления подписки
app.post('/api/extend/:id', isAuthenticated, express.json(), (req, res) => {
    const { id } = req.params;
    const { duration, unit } = req.body;
    
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        subscriptions[id].expiryDate = calculateExpiryDate(duration, unit).toISOString();
        // Если была уничтожена - восстанавливаем
        if (subscriptions[id].isDestroyed && subscriptions[id].originalContent) {
            subscriptions[id].masterConfig = subscriptions[id].originalContent;
            subscriptions[id].content = subscriptions[id].originalContent;
            subscriptions[id].isDestroyed = false;
            subscriptions[id].originalContent = null;
            // Восстанавливаем устройства
            if (subscriptions[id].devices) {
                for (const devId in subscriptions[id].devices) {
                    subscriptions[id].devices[devId].active = true;
                    subscriptions[id].devices[devId].config = subscriptions[id].masterConfig;
                }
            }
        }
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

// 🔥 ГЛАВНЫЙ ОБРАБОТЧИК ПОДПИСКИ - с учётом трафика, истечения, устройств
app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (!subscriptions[id]) {
        return res.status(404).send('Link not found');
    }
    
    const sub = subscriptions[id];
    let deviceId = req.query.deviceId;
    
    // Если нет deviceId, создаем новый и редиректим
    if (!deviceId) {
        deviceId = uuidv4();
        return res.redirect(`/p/${id}?deviceId=${deviceId}`);
    }
    
    sub.count = (sub.count || 0) + 1;
    
    // Получаем данные о пользователе
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || '0.0.0.0';
    const country = await getCountryFromIP(ip);
    
    // Инициализируем devices если нет
    if (!sub.devices) sub.devices = {};
    
    // Создаем или обновляем устройство
    if (!sub.devices[deviceId]) {
        sub.devices[deviceId] = {
            name: country,
            country: country,
            ip: ip,
            userAgent: req.headers['user-agent'],
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            active: true,
            config: sub.masterConfig || sub.content,
            trafficUsed: 0
        };
    } else {
        const device = sub.devices[deviceId];
        device.lastSeen = new Date().toISOString();
        device.ip = ip;
        // Обновляем страну если изменилась
        if (device.country !== country) device.country = country;
        // 🔥 Обновляем конфиг если мастер изменился (фикс бага)
        if (device.active && !sub.isDestroyed && device.config !== sub.masterConfig) {
            device.config = sub.masterConfig;
        }
        // 🔥 Учёт трафика (упрощённо: +1МБ за запрос, в продакшене нужно анализировать заголовки)
        device.trafficUsed = (device.trafficUsed || 0) + 1024 * 1024;
    }
    
    // 🔥 Проверка лимитов перед отдачей
    if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
        console.log(`🔥 Подписка ${id} заблокирована при доступе`);
        applyDestroyConfig(sub);
    }
    
    saveToGist();
    
    // Отдаем конфиг
    const device = sub.devices[deviceId];
    const configToSend = (device?.active && !sub.isDestroyed) ? device.config : DESTROY_CONFIG;
    
    // Запрещаем кеширование
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(configToSend);
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id] && 
        (subscriptions[req.params.id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        delete subscriptions[req.params.id];
        saveToGist();
    }
    res.redirect('/');
});

app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && 
        (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        if (!subscriptions[id].originalContent) {
            subscriptions[id].originalContent = subscriptions[id].masterConfig || subscriptions[id].content;
        }
        applyDestroyConfig(subscriptions[id]);
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].originalContent && 
        (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        subscriptions[id].masterConfig = subscriptions[id].originalContent;
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        subscriptions[id].isDestroyed = false;
        
        // Восстанавливаем все устройства
        if (subscriptions[id].devices) {
            for (const deviceId in subscriptions[id].devices) {
                subscriptions[id].devices[deviceId].active = true;
                subscriptions[id].devices[deviceId].config = subscriptions[id].masterConfig;
            }
        }
        
        saveToGist();
    }
    res.redirect('/');
});

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>"']/g, function(m) {
        return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m] || m;
    });
}

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    console.log(`🚀 VPN Admin Panel v1.6 запущен на порту ${PORT}`);
    loadUsers();
    await loadFromGist();
    // Первая проверка подписок при старте
    checkSubscriptions();
});
