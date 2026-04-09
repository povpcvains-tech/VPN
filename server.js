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
let templates = {
    normal: [],
    lte: []
};
let blockedUsers = {};
let frozenUsers = {};
const BACKUP_FILE = './backup.json';
const USERS_FILE = './users.json';
const TEMPLATES_FILE = './templates.json';
const BLOCKED_FILE = './blocked.json';
const PROFILE_PREFIX = '# profile-update-interval: 1\n';
const DESTROY_CONFIG = 'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=random&pbk=00000000000000000000000000000000000000000000&sid=0000000000000000&type=tcp&headerType=none#VLESS_Reality_Example';

const upload = multer({ storage: multer.memoryStorage() });

// ==================== ЗАГРУЗКА ДАННЫХ ====================
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } else {
            const hashedPassword = bcrypt.hashSync('123', 10);
            users = {
                'admin': {
                    username: 'admin',
                    password: hashedPassword,
                    createdAt: new Date().toISOString(),
                    isAdmin: false
                }
            };
            // Добавляем админскую учетку
            const adminPassword = bcrypt.hashSync('5382197', 10);
            users['YWRtaW4='] = {
                username: 'YWRtaW4=',
                password: adminPassword,
                createdAt: new Date().toISOString(),
                isAdmin: true
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
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

function loadTemplates() {
    try {
        if (fs.existsSync(TEMPLATES_FILE)) {
            const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
            templates = data.templates || { normal: [], lte: [] };
        }
    } catch (error) {
        console.error('Ошибка загрузки шаблонов:', error);
    }
}

function saveTemplates() {
    try {
        fs.writeFileSync(TEMPLATES_FILE, JSON.stringify({ templates }, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения шаблонов:', error);
    }
}

function loadBlockedData() {
    try {
        if (fs.existsSync(BLOCKED_FILE)) {
            const data = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
            blockedUsers = data.blocked || {};
            frozenUsers = data.frozen || {};
        }
    } catch (error) {
        console.error('Ошибка загрузки данных блокировок:', error);
    }
}

function saveBlockedData() {
    try {
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify({ blocked: blockedUsers, frozen: frozenUsers }, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения данных блокировок:', error);
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

function checkSubscriptionExpiry() {
    const now = Date.now();
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.expiryTime && now >= data.expiryTime) {
            if (!data.originalContent) {
                data.originalContent = data.masterConfig || data.content;
            }
            data.masterConfig = addPrefix(DESTROY_CONFIG);
            data.content = addPrefix(DESTROY_CONFIG);
            data.expired = true;
            
            if (data.devices) {
                for (const deviceId in data.devices) {
                    data.devices[deviceId].active = false;
                    data.devices[deviceId].config = DESTROY_CONFIG;
                }
            }
        }
        
        // Проверка лимита трафика
        if (data.trafficLimit && data.totalTraffic >= data.trafficLimit) {
            if (!data.originalContent) {
                data.originalContent = data.masterConfig || data.content;
            }
            data.masterConfig = addPrefix(DESTROY_CONFIG);
            data.content = addPrefix(DESTROY_CONFIG);
            data.trafficExpired = true;
            
            if (data.devices) {
                for (const deviceId in data.devices) {
                    data.devices[deviceId].active = false;
                    data.devices[deviceId].config = DESTROY_CONFIG;
                }
            }
        }
    }
}

// Запускаем проверку каждую минуту
setInterval(() => {
    checkSubscriptionExpiry();
    saveToGist();
}, 60000);

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
                
                // Миграция старых данных
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) {
                        data.masterConfig = data.content;
                    }
                    if (!data.devices) {
                        data.devices = {};
                    }
                    if (data.trafficLimit === undefined) {
                        data.trafficLimit = 0;
                        data.totalTraffic = 0;
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
    secret: 'vpn-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated && req.session.userId) {
        // Проверка блокировки
        if (blockedUsers[req.session.userId]) {
            const blockInfo = blockedUsers[req.session.userId];
            if (blockInfo.permanent || new Date(blockInfo.until) > new Date()) {
                req.session.destroy();
                return res.redirect('/login?error=blocked');
            }
        }
        next();
    } else {
        res.redirect('/login');
    }
}

function isAdmin(req, res, next) {
    if (req.session.authenticated && users[req.session.userId]?.isAdmin) {
        next();
    } else {
        res.status(403).send('Доступ запрещен');
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
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
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
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    users[username] = {
        username: username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        isAdmin: false
    };
    
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== СТРАНИЦА ВХОДА ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'no_file' ? '❌ Файл не выбран' : 
                  req.query.error === 'invalid' ? '❌ Неверный формат файла' : 
                  req.query.error === 'auth' ? '❌ Неверный логин или пароль' :
                  req.query.error === 'blocked' ? '❌ Ваш аккаунт заблокирован' : '';
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
        // Проверка заморозки
        if (frozenUsers[username]) {
            const freezeInfo = frozenUsers[username];
            if (freezeInfo.permanent || new Date(freezeInfo.until) > new Date()) {
                return res.redirect('/login?error=Аккаунт заморожен');
            }
        }
        
        req.session.authenticated = true;
        req.session.userId = username;
        
        // Обновляем IP и время последнего входа
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        users[username].lastLogin = new Date().toISOString();
        users[username].lastIP = ip;
        saveUsers();
        
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
                body { font-family: Arial; background: #0d1117; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .container { background: #161b22; padding: 30px; border-radius: 12px; width: 400px; }
                h1 { text-align: center; margin-bottom: 20px; }
                input { width: 100%; padding: 10px; margin: 10px 0; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; }
                button { width: 100%; padding: 10px; background: #238636; color: white; border: none; border-radius: 6px; cursor: pointer; }
                .error { background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; margin-bottom: 15px; }
                .success { background: #d4edda; color: #155724; padding: 10px; border-radius: 6px; margin-bottom: 15px; }
                .back { text-align: center; margin-top: 15px; }
                .back a { color: #58a6ff; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 Смена пароля</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                ${req.query.success ? '<div class="success">✅ Пароль успешно изменен!</div>' : ''}
                <form action="/change-password" method="POST">
                    <input type="password" name="current_password" placeholder="Текущий пароль" required>
                    <input type="password" name="new_password" placeholder="Новый пароль" required>
                    <input type="password" name="confirm_password" placeholder="Подтвердите новый пароль" required>
                    <button type="submit">Сменить пароль</button>
                </form>
                <div class="back">
                    <a href="/">← Назад</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/change-password', isAuthenticated, (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const userId = req.session.userId;
    
    if (!bcrypt.compareSync(current_password, users[userId].password)) {
        return res.redirect('/change-password?error=Неверный текущий пароль');
    }
    
    if (new_password !== confirm_password) {
        return res.redirect('/change-password?error=Новые пароли не совпадают');
    }
    
    users[userId].password = bcrypt.hashSync(new_password, 10);
    saveUsers();
    
    res.redirect('/change-password?success=true');
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
        version: '1.0',
        exportDate: new Date().toISOString(),
        totalLinks: Object.keys(subscriptions).length,
        subscriptions: subscriptions
    };
    
    const jsonString = JSON.stringify(exportData, null, 2);
    const base64Data = Buffer.from(jsonString).toString('base64');
    
    const fileContent = `VPN SUBSCRIPTIONS BACKUP
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

// ==================== ДАШБОРД ====================
app.get('/', isAuthenticated, (req, res) => {
    let linksHtml = '';
    const linksCount = Object.keys(subscriptions).filter(id => subscriptions[id].owner === req.session.userId).length;
    
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner !== req.session.userId) continue;
        
        const shortContent = removePrefix(data.masterConfig || data.content || '').substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.masterConfig || data.content || '').length > 50 ? '...' : '');
        const devicesCount = data.devices ? Object.keys(data.devices).length : 0;
        const trafficInfo = data.trafficLimit ? `<br>📊 Трафик: ${(data.totalTraffic || 0).toFixed(2)} MB / ${data.trafficLimit} MB` : '';
        const nameInfo = data.name ? `<br>📌 ${data.name}` : '';
        const expiryInfo = data.expiryTime ? `<br>⏰ Истекает: ${new Date(data.expiryTime).toLocaleString()}` : '';
        
        linksHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px;">
                    <code style="color: #0f0; font-size: 16px;">🔗 /p/${id}</code>
                    <button onclick="copyWithNewDevice('${id}')" style="background: #1f6392; padding: 5px 10px;">📋 Копировать (новое устр-во)</button>
                    <button onclick="window.open('/generate-qrcode/${id}', '_blank', 'width=400,height=500')" style="background: #ff9800; padding: 5px 10px;">📱 QR-код (новое устр-во)</button>
                </div>
                <div style="margin-bottom: 8px; color: #58a6ff;">📝 ${escapeHtml(displayContent)}${nameInfo}${trafficInfo}${expiryInfo}</div>
                <div style="margin-bottom: 12px;">👥 ${data.count || 0} переходов | 📱 ${devicesCount} устройств</div>
                <div>
                    <button onclick="editLink('${id}')" style="background: #1f6392;">✏️ Изменить</button>
                    <button onclick="showDevices('${id}')" style="background: #6f42c1;">📱 Устройства</button>
                    <button onclick="setExpiry('${id}')" style="background: #ff9800;">⏰ Срок подписки</button>
                    <button onclick="setTraffic('${id}')" style="background: #00bcd4;">📊 Лимит трафика</button>
                    ${!data.paid ? `<button onclick="markAsPaid('${id}')" style="background: #4caf50;">💰 Оплатил?</button>` : ''}
                    <form action="/destroy/${id}" method="POST" style="display: inline;" onsubmit="event.preventDefault(); if(confirm('Уничтожить подписку?')) this.submit();">
                        <button type="submit" style="background: #8b0000;">💀 Уничтожить</button>
                    </form>
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
    
    // Админская панель
    let adminPanel = '';
    if (users[req.session.userId]?.isAdmin) {
        const totalUsers = Object.keys(users).length;
        let usersList = '';
        for (const [username, userData] of Object.entries(users)) {
            if (username === req.session.userId) continue;
            
            const userLinks = Object.values(subscriptions).filter(s => s.owner === username).length;
            const ip = userData.lastIP || 'Неизвестно';
            
            usersList += `
                <div style="margin: 10px 0; padding: 15px; border: 1px solid #ff9800; background: #1e1e1e; border-radius: 8px;">
                    <strong>👤 Логин: ${username}</strong><br>
                    🔑 Пароль: ${'•'.repeat(8)}<br>
                    🌐 IP: ${ip}<br>
                    📅 Создан: ${new Date(userData.createdAt).toLocaleString()}<br>
                    🔗 Всего создано ссылок: ${userLinks}<br>
                    <div style="margin-top: 10px;">
                        <button onclick="viewUserContent('${username}')" style="background: #1f6392;">👁 Смотреть содержимое</button>
                        <button onclick="loginAsUser('${username}')" style="background: #6f42c1;">🔐 Зайти в профиль</button>
                        <button onclick="warnUser('${username}')" style="background: #ff9800;">⚠️ Предупредить</button>
                        <button onclick="blockUser('${username}')" style="background: #d32f2f;">🚫 Блокировать</button>
                        <button onclick="freezeUser('${username}')" style="background: #00bcd4;">❄️ Заморозить</button>
                        <button onclick="deleteUser('${username}')" style="background: #8b0000;">🗑 Удалить</button>
                    </div>
                </div>
            `;
        }
        
        adminPanel = `
            <div class="card" style="border: 2px solid #ff9800;">
                <h2>👑 Админ-панель</h2>
                <p>📊 Всего пользователей: ${totalUsers}</p>
                ${usersList}
            </div>
        `;
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
                .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
                .modal-content { background: #161b22; margin: 50px auto; padding: 20px; width: 80%; max-width: 600px; border-radius: 12px; max-height: 80vh; overflow-y: auto; }
                .close { color: #fff; float: right; font-size: 28px; cursor: pointer; }
                .device-item { padding: 10px; margin: 5px 0; background: #0d1117; border-radius: 6px; }
                .device-active { border-left: 4px solid #238636; }
                .device-inactive { border-left: 4px solid #d32f2f; opacity: 0.7; }
                .template-section { margin-top: 15px; padding: 10px; background: #0d1117; border-radius: 6px; }
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
                
                function setExpiry(id) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>⏰ Установить срок подписки</h2>
                        <select id="expiryType">
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                            <option value="months">Месяцы</option>
                        </select>
                        <input type="number" id="expiryValue" placeholder="Количество" min="1">
                        <button onclick="saveExpiry('\${id}')">Сохранить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    modal.style.display = 'block';
                }
                
                function saveExpiry(id) {
                    const type = document.getElementById('expiryType').value;
                    const value = parseInt(document.getElementById('expiryValue').value);
                    
                    fetch('/set-expiry/' + id, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({type, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function setTraffic(id) {
                    const limit = prompt('Введите лимит трафика в MB:');
                    if (limit) {
                        fetch('/set-traffic/' + id, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({limit: parseFloat(limit)})
                        }).then(() => location.reload());
                    }
                }
                
                function markAsPaid(id) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>💰 Продлить подписку</h2>
                        <select id="extendType">
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                            <option value="months">Месяцы</option>
                        </select>
                        <input type="number" id="extendValue" placeholder="Количество" min="1">
                        <button onclick="extendSubscription('\${id}')">Продлить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    modal.style.display = 'block';
                }
                
                function extendSubscription(id) {
                    const type = document.getElementById('extendType').value;
                    const value = parseInt(document.getElementById('extendValue').value);
                    
                    fetch('/extend-subscription/' + id, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({type, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
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
                                            <strong>\${device.name}</strong><br>
                                            IP: \${device.ip}<br>
                                            UUID: \${uuid}<br>
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
                            document.getElementById('modalContent').innerHTML = html;
                            document.getElementById('modal').style.display = 'block';
                        });
                }
                
                function deactivateDevice(linkId, deviceId) {
                    if (confirm('Деактивировать устройство? Конфиг будет изменен на нерабочий.')) {
                        fetch('/deactivate-device/' + linkId + '/' + deviceId, {
                            method: 'POST'
                        }).then(() => {
                            showDevices(linkId);
                        });
                    }
                }
                
                function restoreDevice(linkId, deviceId) {
                    if (confirm('Восстановить устройство?')) {
                        fetch('/restore-device/' + linkId + '/' + deviceId, {
                            method: 'POST'
                        }).then(() => {
                            showDevices(linkId);
                        });
                    }
                }
                
                function closeModal() {
                    document.getElementById('modal').style.display = 'none';
                }
                
                // Админские функции
                function viewUserContent(username) {
                    fetch('/admin/user-content/' + username)
                        .then(r => r.json())
                        .then(data => {
                            let html = '<h2>📋 Содержимое пользователя ' + username + '</h2>';
                            html += '<p>Ссылки:</p>';
                            for (const [id, link] of Object.entries(data.links)) {
                                html += '<div style="padding:5px;margin:5px 0;background:#0d1117;">';
                                html += 'ID: ' + id + '<br>';
                                html += 'Конфиг: ' + (link.masterConfig || '').substring(0, 100) + '...';
                                html += '</div>';
                            }
                            html += '<button onclick="closeModal()">Закрыть</button>';
                            document.getElementById('modalContent').innerHTML = html;
                            document.getElementById('modal').style.display = 'block';
                        });
                }
                
                function loginAsUser(username) {
                    if (confirm('Войти как пользователь ' + username + '?')) {
                        fetch('/admin/login-as/' + username, {method: 'POST'})
                            .then(() => location.reload());
                    }
                }
                
                function warnUser(username) {
                    const message = prompt('Введите текст предупреждения:');
                    if (message) {
                        fetch('/admin/warn/' + username, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({message})
                        }).then(() => alert('Предупреждение отправлено'));
                    }
                }
                
                function blockUser(username) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>🚫 Блокировка пользователя</h2>
                        <input type="text" id="blockReason" placeholder="Причина">
                        <select id="blockDuration">
                            <option value="permanent">Навсегда</option>
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                        </select>
                        <input type="number" id="blockValue" placeholder="Количество" min="1" style="display:none;">
                        <button onclick="saveBlock('\${username}')">Заблокировать</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    
                    document.getElementById('blockDuration').onchange = function() {
                        document.getElementById('blockValue').style.display = 
                            this.value === 'permanent' ? 'none' : 'block';
                    };
                    
                    modal.style.display = 'block';
                }
                
                function saveBlock(username) {
                    const reason = document.getElementById('blockReason').value;
                    const duration = document.getElementById('blockDuration').value;
                    const value = document.getElementById('blockValue').value;
                    
                    fetch('/admin/block/' + username, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({reason, duration, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function freezeUser(username) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>❄️ Заморозка пользователя</h2>
                        <input type="text" id="freezeReason" placeholder="Причина">
                        <select id="freezeDuration">
                            <option value="permanent">Навсегда</option>
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                        </select>
                        <input type="number" id="freezeValue" placeholder="Количество" min="1" style="display:none;">
                        <button onclick="saveFreeze('\${username}')">Заморозить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    
                    document.getElementById('freezeDuration').onchange = function() {
                        document.getElementById('freezeValue').style.display = 
                            this.value === 'permanent' ? 'none' : 'block';
                    };
                    
                    modal.style.display = 'block';
                }
                
                function saveFreeze(username) {
                    const reason = document.getElementById('freezeReason').value;
                    const duration = document.getElementById('freezeDuration').value;
                    const value = document.getElementById('freezeValue').value;
                    
                    fetch('/admin/freeze/' + username, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({reason, duration, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function deleteUser(username) {
                    if (confirm('Удалить пользователя ' + username + ' навсегда?')) {
                        fetch('/admin/delete-user/' + username, {method: 'POST'})
                            .then(() => location.reload());
                    }
                }
                
                function showTemplate(type) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            let html = '<h2>📋 Шаблоны</h2>';
                            templates.forEach((t, i) => {
                                html += \`
                                    <div style="padding:10px;margin:5px 0;background:#0d1117;cursor:pointer;" 
                                         onclick="selectTemplate('\${type}', \${i})">
                                        \${t.name}<br>
                                        <small>\${t.config.substring(0, 50)}...</small>
                                    </div>
                                \`;
                            });
                            html += '<button onclick="closeModal()">Отмена</button>';
                            content.innerHTML = html;
                            modal.style.display = 'block';
                        });
                }
                
                function selectTemplate(type, index) {
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            const template = templates[index];
                            document.getElementById('configContent').value = template.config;
                            closeModal();
                        });
                }
            </script>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 20px;">
                <span style="font-size: 18px;">👤 ${req.session.userId}</span>
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
                <a href="/export-all"><button class="export">💾 Скачать все ссылки</button></a>
                <a href="/change-password"><button style="background: #6f42c1;">🔐 Сменить пароль</button></a>
            </div>
            
            ${adminPanel}
            
            <div class="card">
                <h1>🔐 Создать ссылку</h1>
                <select id="createMode" onchange="toggleCreateMode()">
                    <option value="simple">Без шаблона</option>
                    <option value="template">Свой шаблон</option>
                </select>
                
                <div id="simpleMode">
                    <textarea id="configContent" placeholder="Введите конфиг VPN" rows="4" required></textarea>
                    <input type="text" id="linkName" placeholder="Название подписки (опционально)">
                    <button onclick="createLink()" class="generate">✨ Сгенерировать</button>
                </div>
                
                <div id="templateMode" style="display:none;">
                    <div class="template-section">
                        <h3>⬇️ Обычные сервера ⬇️</h3>
                        <button onclick="showTemplate('normal')">Выбрать шаблон</button>
                    </div>
                    <div class="template-section">
                        <h3>⬇️ LTE Сервера ⬇️</h3>
                        <button onclick="showTemplate('lte')">Выбрать шаблон</button>
                    </div>
                    <div class="template-section">
                        <h3>📝 Свой текст</h3>
                        <textarea id="customTemplate" placeholder="Введите свой конфиг"></textarea>
                    </div>
                    <input type="text" id="templateLinkName" placeholder="Название подписки">
                    <button onclick="createFromTemplate()" class="generate">✨ Сгенерировать из шаблона</button>
                </div>
            </div>
            
            <div class="card">
                <h2>📋 Мои ссылки (${linksCount})</h2>
                ${linksHtml || '<p>Нет ссылок. Создайте первую!</p>'}
            </div>
            
            <div id="modal" class="modal">
                <div class="modal-content">
                    <span class="close" onclick="closeModal()">&times;</span>
                    <div id="modalContent"></div>
                </div>
            </div>
            
            <script>
                function toggleCreateMode() {
                    const mode = document.getElementById('createMode').value;
                    document.getElementById('simpleMode').style.display = mode === 'simple' ? 'block' : 'none';
                    document.getElementById('templateMode').style.display = mode === 'template' ? 'block' : 'none';
                }
                
                function createLink() {
                    const content = document.getElementById('configContent').value;
                    const name = document.getElementById('linkName').value;
                    
                    fetch('/generate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({content, name})
                    }).then(() => location.reload());
                }
                
                function createFromTemplate() {
                    const content = document.getElementById('customTemplate').value;
                    const name = document.getElementById('templateLinkName').value;
                    
                    if (!content) {
                        alert('Выберите шаблон или введите свой конфиг');
                        return;
                    }
                    
                    fetch('/generate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({content, name})
                    }).then(() => location.reload());
                }
                
                function showTemplate(type) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            let html = '<h2>📋 Шаблоны</h2>';
                            templates.forEach((t, i) => {
                                html += \`
                                    <div style="padding:10px;margin:5px 0;background:#0d1117;cursor:pointer;" 
                                         onclick="selectTemplate('\${type}', \${i})">
                                        <strong>\${t.name}</strong><br>
                                        <small>\${t.config.substring(0, 80)}...</small>
                                    </div>
                                \`;
                            });
                            html += '<button onclick="closeModal()">Отмена</button>';
                            content.innerHTML = html;
                            modal.style.display = 'block';
                        });
                }
                
                function selectTemplate(type, index) {
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            const template = templates[index];
                            document.getElementById('customTemplate').value = template.config;
                            document.getElementById('templateLinkName').value = template.name;
                            closeModal();
                        });
                }
            </script>
        </body>
        </html>
    `);
});

// ==================== ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, express.json(), (req, res) => {
    const id = generateRandomId();
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content),
        content: addPrefix(req.body.content),
        originalContent: null,
        count: 0,
        devices: {},
        owner: req.session.userId,
        name: req.body.name || null,
        trafficLimit: 0,
        totalTraffic: 0,
        expiryTime: null,
        paid: false
    };
    saveToGist();
    res.json({success: true});
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        
        // Обновляем конфиг для всех устройств
        if (subscriptions[id].devices) {
            for (const deviceId in subscriptions[id].devices) {
                if (subscriptions[id].devices[deviceId].active) {
                    subscriptions[id].devices[deviceId].config = subscriptions[id].masterConfig;
                }
            }
        }
        
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/set-expiry/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        const { type, value } = req.body;
        let milliseconds = 0;
        
        switch(type) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
            case 'months': milliseconds = value * 30 * 24 * 60 * 60 * 1000; break;
        }
        
        subscriptions[id].expiryTime = Date.now() + milliseconds;
        subscriptions[id].paid = true;
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/extend-subscription/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        const { type, value } = req.body;
        let milliseconds = 0;
        
        switch(type) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
            case 'months': milliseconds = value * 30 * 24 * 60 * 60 * 1000; break;
        }
        
        const currentExpiry = subscriptions[id].expiryTime || Date.now();
        subscriptions[id].expiryTime = currentExpiry + milliseconds;
        subscriptions[id].paid = true;
        subscriptions[id].expired = false;
        
        // Восстанавливаем если было уничтожено
        if (subscriptions[id].originalContent) {
            subscriptions[id].masterConfig = subscriptions[id].originalContent;
            subscriptions[id].content = subscriptions[id].originalContent;
            subscriptions[id].originalContent = null;
            
            if (subscriptions[id].devices) {
                for (const deviceId in subscriptions[id].devices) {
                    subscriptions[id].devices[deviceId].active = true;
                    subscriptions[id].devices[deviceId].config = subscriptions[id].masterConfig;
                }
            }
        }
        
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/set-traffic/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        subscriptions[id].trafficLimit = req.body.limit;
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/templates/:type', isAuthenticated, (req, res) => {
    const type = req.params.type;
    res.json(templates[type] || []);
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        res.json(subscriptions[id].devices || {});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].owner === req.session.userId && 
        subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
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
    if (subscriptions[linkId] && subscriptions[linkId].owner === req.session.userId && 
        subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
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

app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        let deviceId = req.query.deviceId;
        
        if (!deviceId) {
            deviceId = uuidv4();
            return res.redirect(`/p/${id}?deviceId=${deviceId}`);
        }
        
        subscriptions[id].count++;
        
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const country = await getCountryFromIP(ip);
        
        if (!subscriptions[id].devices) {
            subscriptions[id].devices = {};
        }
        
        if (!subscriptions[id].devices[deviceId]) {
            subscriptions[id].devices[deviceId] = {
                name: country,
                ip: ip,
                userAgent: req.headers['user-agent'],
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                active: true,
                config: subscriptions[id].masterConfig || subscriptions[id].content
            };
        } else {
            subscriptions[id].devices[deviceId].lastSeen = new Date().toISOString();
            subscriptions[id].devices[deviceId].ip = ip;
        }
        
        // Учет трафика (примерно)
        if (subscriptions[id].trafficLimit) {
            subscriptions[id].totalTraffic = (subscriptions[id].totalTraffic || 0) + 0.1;
        }
        
        saveToGist();
        
        const device = subscriptions[id].devices[deviceId];
        const configToSend = device.active ? device.config : DESTROY_CONFIG;
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(configToSend);
    } else {
        res.status(404).send('Link not found');
    }
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        delete subscriptions[id];
        saveToGist();
    }
    res.redirect('/');
});

app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        if (!subscriptions[id].originalContent) {
            subscriptions[id].originalContent = subscriptions[id].masterConfig || subscriptions[id].content;
        }
        subscriptions[id].masterConfig = addPrefix(DESTROY_CONFIG);
        subscriptions[id].content = addPrefix(DESTROY_CONFIG);
        
        if (subscriptions[id].devices) {
            for (const deviceId in subscriptions[id].devices) {
                subscriptions[id].devices[deviceId].active = false;
                subscriptions[id].devices[deviceId].config = DESTROY_CONFIG;
            }
        }
        
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId && subscriptions[id].originalContent) {
        subscriptions[id].masterConfig = subscriptions[id].originalContent;
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        
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

// ==================== АДМИНСКИЕ ФУНКЦИИ ====================
app.get('/admin/user-content/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    const userLinks = {};
    
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner === username) {
            userLinks[id] = data;
        }
    }
    
    res.json({links: userLinks});
});

app.post('/admin/login-as/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    if (users[username]) {
        req.session.authenticated = true;
        req.session.userId = username;
        req.session.adminSession = true;
        res.json({success: true});
    } else {
        res.status(404).json({error: 'User not found'});
    }
});

app.post('/admin/warn/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { message } = req.body;
    
    if (!users[username].warnings) {
        users[username].warnings = [];
    }
    
    users[username].warnings.push({
        message,
        date: new Date().toISOString(),
        from: req.session.userId
    });
    
    saveUsers();
    res.json({success: true});
});

app.post('/admin/block/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { reason, duration, value } = req.body;
    
    let until = null;
    let permanent = duration === 'permanent';
    
    if (!permanent) {
        let milliseconds = 0;
        switch(duration) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
        }
        until = new Date(Date.now() + milliseconds);
    }
    
    blockedUsers[username] = {
        reason,
        until,
        permanent,
        blockedAt: new Date().toISOString(),
        blockedBy: req.session.userId
    };
    
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/unblock/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    delete blockedUsers[username];
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/freeze/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { reason, duration, value } = req.body;
    
    let until = null;
    let permanent = duration === 'permanent';
    
    if (!permanent) {
        let milliseconds = 0;
        switch(duration) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
        }
        until = new Date(Date.now() + milliseconds);
    }
    
    frozenUsers[username] = {
        reason,
        until,
        permanent,
        frozenAt: new Date().toISOString(),
        frozenBy: req.session.userId
    };
    
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/unfreeze/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    delete frozenUsers[username];
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/delete-user/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    
    // Удаляем все ссылки пользователя
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner === username) {
            delete subscriptions[id];
        }
    }
    
    // Удаляем пользователя
    delete users[username];
    delete blockedUsers[username];
    delete frozenUsers[username];
    
    saveUsers();
    saveBlockedData();
    saveToGist();
    
    res.json({success: true});
});

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    loadUsers();
    loadTemplates();
    loadBlockedData();
    await loadFromGist();
    console.log('✅ Система готова к работе');
});const express = require('express');
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
let templates = {
    normal: [],
    lte: []
};
let blockedUsers = {};
let frozenUsers = {};
const BACKUP_FILE = './backup.json';
const USERS_FILE = './users.json';
const TEMPLATES_FILE = './templates.json';
const BLOCKED_FILE = './blocked.json';
const PROFILE_PREFIX = '# profile-update-interval: 1\n';
const DESTROY_CONFIG = 'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=random&pbk=00000000000000000000000000000000000000000000&sid=0000000000000000&type=tcp&headerType=none#VLESS_Reality_Example';

const upload = multer({ storage: multer.memoryStorage() });

// ==================== ЗАГРУЗКА ДАННЫХ ====================
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } else {
            const hashedPassword = bcrypt.hashSync('123', 10);
            users = {
                'admin': {
                    username: 'admin',
                    password: hashedPassword,
                    createdAt: new Date().toISOString(),
                    isAdmin: false
                }
            };
            // Добавляем админскую учетку
            const adminPassword = bcrypt.hashSync('5382197', 10);
            users['YWRtaW4='] = {
                username: 'YWRtaW4=',
                password: adminPassword,
                createdAt: new Date().toISOString(),
                isAdmin: true
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
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

function loadTemplates() {
    try {
        if (fs.existsSync(TEMPLATES_FILE)) {
            const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
            templates = data.templates || { normal: [], lte: [] };
        }
    } catch (error) {
        console.error('Ошибка загрузки шаблонов:', error);
    }
}

function saveTemplates() {
    try {
        fs.writeFileSync(TEMPLATES_FILE, JSON.stringify({ templates }, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения шаблонов:', error);
    }
}

function loadBlockedData() {
    try {
        if (fs.existsSync(BLOCKED_FILE)) {
            const data = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
            blockedUsers = data.blocked || {};
            frozenUsers = data.frozen || {};
        }
    } catch (error) {
        console.error('Ошибка загрузки данных блокировок:', error);
    }
}

function saveBlockedData() {
    try {
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify({ blocked: blockedUsers, frozen: frozenUsers }, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения данных блокировок:', error);
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

function checkSubscriptionExpiry() {
    const now = Date.now();
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.expiryTime && now >= data.expiryTime) {
            if (!data.originalContent) {
                data.originalContent = data.masterConfig || data.content;
            }
            data.masterConfig = addPrefix(DESTROY_CONFIG);
            data.content = addPrefix(DESTROY_CONFIG);
            data.expired = true;
            
            if (data.devices) {
                for (const deviceId in data.devices) {
                    data.devices[deviceId].active = false;
                    data.devices[deviceId].config = DESTROY_CONFIG;
                }
            }
        }
        
        // Проверка лимита трафика
        if (data.trafficLimit && data.totalTraffic >= data.trafficLimit) {
            if (!data.originalContent) {
                data.originalContent = data.masterConfig || data.content;
            }
            data.masterConfig = addPrefix(DESTROY_CONFIG);
            data.content = addPrefix(DESTROY_CONFIG);
            data.trafficExpired = true;
            
            if (data.devices) {
                for (const deviceId in data.devices) {
                    data.devices[deviceId].active = false;
                    data.devices[deviceId].config = DESTROY_CONFIG;
                }
            }
        }
    }
}

// Запускаем проверку каждую минуту
setInterval(() => {
    checkSubscriptionExpiry();
    saveToGist();
}, 60000);

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
                
                // Миграция старых данных
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) {
                        data.masterConfig = data.content;
                    }
                    if (!data.devices) {
                        data.devices = {};
                    }
                    if (data.trafficLimit === undefined) {
                        data.trafficLimit = 0;
                        data.totalTraffic = 0;
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
    secret: 'vpn-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated && req.session.userId) {
        // Проверка блокировки
        if (blockedUsers[req.session.userId]) {
            const blockInfo = blockedUsers[req.session.userId];
            if (blockInfo.permanent || new Date(blockInfo.until) > new Date()) {
                req.session.destroy();
                return res.redirect('/login?error=blocked');
            }
        }
        next();
    } else {
        res.redirect('/login');
    }
}

function isAdmin(req, res, next) {
    if (req.session.authenticated && users[req.session.userId]?.isAdmin) {
        next();
    } else {
        res.status(403).send('Доступ запрещен');
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
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
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
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    users[username] = {
        username: username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        isAdmin: false
    };
    
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== СТРАНИЦА ВХОДА ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'no_file' ? '❌ Файл не выбран' : 
                  req.query.error === 'invalid' ? '❌ Неверный формат файла' : 
                  req.query.error === 'auth' ? '❌ Неверный логин или пароль' :
                  req.query.error === 'blocked' ? '❌ Ваш аккаунт заблокирован' : '';
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
        // Проверка заморозки
        if (frozenUsers[username]) {
            const freezeInfo = frozenUsers[username];
            if (freezeInfo.permanent || new Date(freezeInfo.until) > new Date()) {
                return res.redirect('/login?error=Аккаунт заморожен');
            }
        }
        
        req.session.authenticated = true;
        req.session.userId = username;
        
        // Обновляем IP и время последнего входа
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        users[username].lastLogin = new Date().toISOString();
        users[username].lastIP = ip;
        saveUsers();
        
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
                body { font-family: Arial; background: #0d1117; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .container { background: #161b22; padding: 30px; border-radius: 12px; width: 400px; }
                h1 { text-align: center; margin-bottom: 20px; }
                input { width: 100%; padding: 10px; margin: 10px 0; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; }
                button { width: 100%; padding: 10px; background: #238636; color: white; border: none; border-radius: 6px; cursor: pointer; }
                .error { background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; margin-bottom: 15px; }
                .success { background: #d4edda; color: #155724; padding: 10px; border-radius: 6px; margin-bottom: 15px; }
                .back { text-align: center; margin-top: 15px; }
                .back a { color: #58a6ff; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 Смена пароля</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                ${req.query.success ? '<div class="success">✅ Пароль успешно изменен!</div>' : ''}
                <form action="/change-password" method="POST">
                    <input type="password" name="current_password" placeholder="Текущий пароль" required>
                    <input type="password" name="new_password" placeholder="Новый пароль" required>
                    <input type="password" name="confirm_password" placeholder="Подтвердите новый пароль" required>
                    <button type="submit">Сменить пароль</button>
                </form>
                <div class="back">
                    <a href="/">← Назад</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/change-password', isAuthenticated, (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const userId = req.session.userId;
    
    if (!bcrypt.compareSync(current_password, users[userId].password)) {
        return res.redirect('/change-password?error=Неверный текущий пароль');
    }
    
    if (new_password !== confirm_password) {
        return res.redirect('/change-password?error=Новые пароли не совпадают');
    }
    
    users[userId].password = bcrypt.hashSync(new_password, 10);
    saveUsers();
    
    res.redirect('/change-password?success=true');
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
        version: '1.0',
        exportDate: new Date().toISOString(),
        totalLinks: Object.keys(subscriptions).length,
        subscriptions: subscriptions
    };
    
    const jsonString = JSON.stringify(exportData, null, 2);
    const base64Data = Buffer.from(jsonString).toString('base64');
    
    const fileContent = `VPN SUBSCRIPTIONS BACKUP
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

// ==================== ДАШБОРД ====================
app.get('/', isAuthenticated, (req, res) => {
    let linksHtml = '';
    const linksCount = Object.keys(subscriptions).filter(id => subscriptions[id].owner === req.session.userId).length;
    
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner !== req.session.userId) continue;
        
        const shortContent = removePrefix(data.masterConfig || data.content || '').substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.masterConfig || data.content || '').length > 50 ? '...' : '');
        const devicesCount = data.devices ? Object.keys(data.devices).length : 0;
        const trafficInfo = data.trafficLimit ? `<br>📊 Трафик: ${(data.totalTraffic || 0).toFixed(2)} MB / ${data.trafficLimit} MB` : '';
        const nameInfo = data.name ? `<br>📌 ${data.name}` : '';
        const expiryInfo = data.expiryTime ? `<br>⏰ Истекает: ${new Date(data.expiryTime).toLocaleString()}` : '';
        
        linksHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px;">
                    <code style="color: #0f0; font-size: 16px;">🔗 /p/${id}</code>
                    <button onclick="copyWithNewDevice('${id}')" style="background: #1f6392; padding: 5px 10px;">📋 Копировать (новое устр-во)</button>
                    <button onclick="window.open('/generate-qrcode/${id}', '_blank', 'width=400,height=500')" style="background: #ff9800; padding: 5px 10px;">📱 QR-код (новое устр-во)</button>
                </div>
                <div style="margin-bottom: 8px; color: #58a6ff;">📝 ${escapeHtml(displayContent)}${nameInfo}${trafficInfo}${expiryInfo}</div>
                <div style="margin-bottom: 12px;">👥 ${data.count || 0} переходов | 📱 ${devicesCount} устройств</div>
                <div>
                    <button onclick="editLink('${id}')" style="background: #1f6392;">✏️ Изменить</button>
                    <button onclick="showDevices('${id}')" style="background: #6f42c1;">📱 Устройства</button>
                    <button onclick="setExpiry('${id}')" style="background: #ff9800;">⏰ Срок подписки</button>
                    <button onclick="setTraffic('${id}')" style="background: #00bcd4;">📊 Лимит трафика</button>
                    ${!data.paid ? `<button onclick="markAsPaid('${id}')" style="background: #4caf50;">💰 Оплатил?</button>` : ''}
                    <form action="/destroy/${id}" method="POST" style="display: inline;" onsubmit="event.preventDefault(); if(confirm('Уничтожить подписку?')) this.submit();">
                        <button type="submit" style="background: #8b0000;">💀 Уничтожить</button>
                    </form>
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
    
    // Админская панель
    let adminPanel = '';
    if (users[req.session.userId]?.isAdmin) {
        const totalUsers = Object.keys(users).length;
        let usersList = '';
        for (const [username, userData] of Object.entries(users)) {
            if (username === req.session.userId) continue;
            
            const userLinks = Object.values(subscriptions).filter(s => s.owner === username).length;
            const ip = userData.lastIP || 'Неизвестно';
            
            usersList += `
                <div style="margin: 10px 0; padding: 15px; border: 1px solid #ff9800; background: #1e1e1e; border-radius: 8px;">
                    <strong>👤 Логин: ${username}</strong><br>
                    🔑 Пароль: ${'•'.repeat(8)}<br>
                    🌐 IP: ${ip}<br>
                    📅 Создан: ${new Date(userData.createdAt).toLocaleString()}<br>
                    🔗 Всего создано ссылок: ${userLinks}<br>
                    <div style="margin-top: 10px;">
                        <button onclick="viewUserContent('${username}')" style="background: #1f6392;">👁 Смотреть содержимое</button>
                        <button onclick="loginAsUser('${username}')" style="background: #6f42c1;">🔐 Зайти в профиль</button>
                        <button onclick="warnUser('${username}')" style="background: #ff9800;">⚠️ Предупредить</button>
                        <button onclick="blockUser('${username}')" style="background: #d32f2f;">🚫 Блокировать</button>
                        <button onclick="freezeUser('${username}')" style="background: #00bcd4;">❄️ Заморозить</button>
                        <button onclick="deleteUser('${username}')" style="background: #8b0000;">🗑 Удалить</button>
                    </div>
                </div>
            `;
        }
        
        adminPanel = `
            <div class="card" style="border: 2px solid #ff9800;">
                <h2>👑 Админ-панель</h2>
                <p>📊 Всего пользователей: ${totalUsers}</p>
                ${usersList}
            </div>
        `;
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
                .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
                .modal-content { background: #161b22; margin: 50px auto; padding: 20px; width: 80%; max-width: 600px; border-radius: 12px; max-height: 80vh; overflow-y: auto; }
                .close { color: #fff; float: right; font-size: 28px; cursor: pointer; }
                .device-item { padding: 10px; margin: 5px 0; background: #0d1117; border-radius: 6px; }
                .device-active { border-left: 4px solid #238636; }
                .device-inactive { border-left: 4px solid #d32f2f; opacity: 0.7; }
                .template-section { margin-top: 15px; padding: 10px; background: #0d1117; border-radius: 6px; }
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
                
                function setExpiry(id) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>⏰ Установить срок подписки</h2>
                        <select id="expiryType">
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                            <option value="months">Месяцы</option>
                        </select>
                        <input type="number" id="expiryValue" placeholder="Количество" min="1">
                        <button onclick="saveExpiry('\${id}')">Сохранить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    modal.style.display = 'block';
                }
                
                function saveExpiry(id) {
                    const type = document.getElementById('expiryType').value;
                    const value = parseInt(document.getElementById('expiryValue').value);
                    
                    fetch('/set-expiry/' + id, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({type, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function setTraffic(id) {
                    const limit = prompt('Введите лимит трафика в MB:');
                    if (limit) {
                        fetch('/set-traffic/' + id, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({limit: parseFloat(limit)})
                        }).then(() => location.reload());
                    }
                }
                
                function markAsPaid(id) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>💰 Продлить подписку</h2>
                        <select id="extendType">
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                            <option value="months">Месяцы</option>
                        </select>
                        <input type="number" id="extendValue" placeholder="Количество" min="1">
                        <button onclick="extendSubscription('\${id}')">Продлить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    modal.style.display = 'block';
                }
                
                function extendSubscription(id) {
                    const type = document.getElementById('extendType').value;
                    const value = parseInt(document.getElementById('extendValue').value);
                    
                    fetch('/extend-subscription/' + id, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({type, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
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
                                            <strong>\${device.name}</strong><br>
                                            IP: \${device.ip}<br>
                                            UUID: \${uuid}<br>
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
                            document.getElementById('modalContent').innerHTML = html;
                            document.getElementById('modal').style.display = 'block';
                        });
                }
                
                function deactivateDevice(linkId, deviceId) {
                    if (confirm('Деактивировать устройство? Конфиг будет изменен на нерабочий.')) {
                        fetch('/deactivate-device/' + linkId + '/' + deviceId, {
                            method: 'POST'
                        }).then(() => {
                            showDevices(linkId);
                        });
                    }
                }
                
                function restoreDevice(linkId, deviceId) {
                    if (confirm('Восстановить устройство?')) {
                        fetch('/restore-device/' + linkId + '/' + deviceId, {
                            method: 'POST'
                        }).then(() => {
                            showDevices(linkId);
                        });
                    }
                }
                
                function closeModal() {
                    document.getElementById('modal').style.display = 'none';
                }
                
                // Админские функции
                function viewUserContent(username) {
                    fetch('/admin/user-content/' + username)
                        .then(r => r.json())
                        .then(data => {
                            let html = '<h2>📋 Содержимое пользователя ' + username + '</h2>';
                            html += '<p>Ссылки:</p>';
                            for (const [id, link] of Object.entries(data.links)) {
                                html += '<div style="padding:5px;margin:5px 0;background:#0d1117;">';
                                html += 'ID: ' + id + '<br>';
                                html += 'Конфиг: ' + (link.masterConfig || '').substring(0, 100) + '...';
                                html += '</div>';
                            }
                            html += '<button onclick="closeModal()">Закрыть</button>';
                            document.getElementById('modalContent').innerHTML = html;
                            document.getElementById('modal').style.display = 'block';
                        });
                }
                
                function loginAsUser(username) {
                    if (confirm('Войти как пользователь ' + username + '?')) {
                        fetch('/admin/login-as/' + username, {method: 'POST'})
                            .then(() => location.reload());
                    }
                }
                
                function warnUser(username) {
                    const message = prompt('Введите текст предупреждения:');
                    if (message) {
                        fetch('/admin/warn/' + username, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({message})
                        }).then(() => alert('Предупреждение отправлено'));
                    }
                }
                
                function blockUser(username) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>🚫 Блокировка пользователя</h2>
                        <input type="text" id="blockReason" placeholder="Причина">
                        <select id="blockDuration">
                            <option value="permanent">Навсегда</option>
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                        </select>
                        <input type="number" id="blockValue" placeholder="Количество" min="1" style="display:none;">
                        <button onclick="saveBlock('\${username}')">Заблокировать</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    
                    document.getElementById('blockDuration').onchange = function() {
                        document.getElementById('blockValue').style.display = 
                            this.value === 'permanent' ? 'none' : 'block';
                    };
                    
                    modal.style.display = 'block';
                }
                
                function saveBlock(username) {
                    const reason = document.getElementById('blockReason').value;
                    const duration = document.getElementById('blockDuration').value;
                    const value = document.getElementById('blockValue').value;
                    
                    fetch('/admin/block/' + username, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({reason, duration, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function freezeUser(username) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    content.innerHTML = \`
                        <h2>❄️ Заморозка пользователя</h2>
                        <input type="text" id="freezeReason" placeholder="Причина">
                        <select id="freezeDuration">
                            <option value="permanent">Навсегда</option>
                            <option value="minutes">Минуты</option>
                            <option value="hours">Часы</option>
                            <option value="days">Дни</option>
                        </select>
                        <input type="number" id="freezeValue" placeholder="Количество" min="1" style="display:none;">
                        <button onclick="saveFreeze('\${username}')">Заморозить</button>
                        <button onclick="closeModal()">Отмена</button>
                    \`;
                    
                    document.getElementById('freezeDuration').onchange = function() {
                        document.getElementById('freezeValue').style.display = 
                            this.value === 'permanent' ? 'none' : 'block';
                    };
                    
                    modal.style.display = 'block';
                }
                
                function saveFreeze(username) {
                    const reason = document.getElementById('freezeReason').value;
                    const duration = document.getElementById('freezeDuration').value;
                    const value = document.getElementById('freezeValue').value;
                    
                    fetch('/admin/freeze/' + username, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({reason, duration, value})
                    }).then(() => {
                        closeModal();
                        location.reload();
                    });
                }
                
                function deleteUser(username) {
                    if (confirm('Удалить пользователя ' + username + ' навсегда?')) {
                        fetch('/admin/delete-user/' + username, {method: 'POST'})
                            .then(() => location.reload());
                    }
                }
                
                function showTemplate(type) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            let html = '<h2>📋 Шаблоны</h2>';
                            templates.forEach((t, i) => {
                                html += \`
                                    <div style="padding:10px;margin:5px 0;background:#0d1117;cursor:pointer;" 
                                         onclick="selectTemplate('\${type}', \${i})">
                                        \${t.name}<br>
                                        <small>\${t.config.substring(0, 50)}...</small>
                                    </div>
                                \`;
                            });
                            html += '<button onclick="closeModal()">Отмена</button>';
                            content.innerHTML = html;
                            modal.style.display = 'block';
                        });
                }
                
                function selectTemplate(type, index) {
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            const template = templates[index];
                            document.getElementById('configContent').value = template.config;
                            closeModal();
                        });
                }
            </script>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 20px;">
                <span style="font-size: 18px;">👤 ${req.session.userId}</span>
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
                <a href="/export-all"><button class="export">💾 Скачать все ссылки</button></a>
                <a href="/change-password"><button style="background: #6f42c1;">🔐 Сменить пароль</button></a>
            </div>
            
            ${adminPanel}
            
            <div class="card">
                <h1>🔐 Создать ссылку</h1>
                <select id="createMode" onchange="toggleCreateMode()">
                    <option value="simple">Без шаблона</option>
                    <option value="template">Свой шаблон</option>
                </select>
                
                <div id="simpleMode">
                    <textarea id="configContent" placeholder="Введите конфиг VPN" rows="4" required></textarea>
                    <input type="text" id="linkName" placeholder="Название подписки (опционально)">
                    <button onclick="createLink()" class="generate">✨ Сгенерировать</button>
                </div>
                
                <div id="templateMode" style="display:none;">
                    <div class="template-section">
                        <h3>⬇️ Обычные сервера ⬇️</h3>
                        <button onclick="showTemplate('normal')">Выбрать шаблон</button>
                    </div>
                    <div class="template-section">
                        <h3>⬇️ LTE Сервера ⬇️</h3>
                        <button onclick="showTemplate('lte')">Выбрать шаблон</button>
                    </div>
                    <div class="template-section">
                        <h3>📝 Свой текст</h3>
                        <textarea id="customTemplate" placeholder="Введите свой конфиг"></textarea>
                    </div>
                    <input type="text" id="templateLinkName" placeholder="Название подписки">
                    <button onclick="createFromTemplate()" class="generate">✨ Сгенерировать из шаблона</button>
                </div>
            </div>
            
            <div class="card">
                <h2>📋 Мои ссылки (${linksCount})</h2>
                ${linksHtml || '<p>Нет ссылок. Создайте первую!</p>'}
            </div>
            
            <div id="modal" class="modal">
                <div class="modal-content">
                    <span class="close" onclick="closeModal()">&times;</span>
                    <div id="modalContent"></div>
                </div>
            </div>
            
            <script>
                function toggleCreateMode() {
                    const mode = document.getElementById('createMode').value;
                    document.getElementById('simpleMode').style.display = mode === 'simple' ? 'block' : 'none';
                    document.getElementById('templateMode').style.display = mode === 'template' ? 'block' : 'none';
                }
                
                function createLink() {
                    const content = document.getElementById('configContent').value;
                    const name = document.getElementById('linkName').value;
                    
                    fetch('/generate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({content, name})
                    }).then(() => location.reload());
                }
                
                function createFromTemplate() {
                    const content = document.getElementById('customTemplate').value;
                    const name = document.getElementById('templateLinkName').value;
                    
                    if (!content) {
                        alert('Выберите шаблон или введите свой конфиг');
                        return;
                    }
                    
                    fetch('/generate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({content, name})
                    }).then(() => location.reload());
                }
                
                function showTemplate(type) {
                    const modal = document.getElementById('modal');
                    const content = document.getElementById('modalContent');
                    
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            let html = '<h2>📋 Шаблоны</h2>';
                            templates.forEach((t, i) => {
                                html += \`
                                    <div style="padding:10px;margin:5px 0;background:#0d1117;cursor:pointer;" 
                                         onclick="selectTemplate('\${type}', \${i})">
                                        <strong>\${t.name}</strong><br>
                                        <small>\${t.config.substring(0, 80)}...</small>
                                    </div>
                                \`;
                            });
                            html += '<button onclick="closeModal()">Отмена</button>';
                            content.innerHTML = html;
                            modal.style.display = 'block';
                        });
                }
                
                function selectTemplate(type, index) {
                    fetch('/templates/' + type)
                        .then(r => r.json())
                        .then(templates => {
                            const template = templates[index];
                            document.getElementById('customTemplate').value = template.config;
                            document.getElementById('templateLinkName').value = template.name;
                            closeModal();
                        });
                }
            </script>
        </body>
        </html>
    `);
});

// ==================== ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, express.json(), (req, res) => {
    const id = generateRandomId();
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content),
        content: addPrefix(req.body.content),
        originalContent: null,
        count: 0,
        devices: {},
        owner: req.session.userId,
        name: req.body.name || null,
        trafficLimit: 0,
        totalTraffic: 0,
        expiryTime: null,
        paid: false
    };
    saveToGist();
    res.json({success: true});
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        
        // Обновляем конфиг для всех устройств
        if (subscriptions[id].devices) {
            for (const deviceId in subscriptions[id].devices) {
                if (subscriptions[id].devices[deviceId].active) {
                    subscriptions[id].devices[deviceId].config = subscriptions[id].masterConfig;
                }
            }
        }
        
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/set-expiry/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        const { type, value } = req.body;
        let milliseconds = 0;
        
        switch(type) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
            case 'months': milliseconds = value * 30 * 24 * 60 * 60 * 1000; break;
        }
        
        subscriptions[id].expiryTime = Date.now() + milliseconds;
        subscriptions[id].paid = true;
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/extend-subscription/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        const { type, value } = req.body;
        let milliseconds = 0;
        
        switch(type) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
            case 'months': milliseconds = value * 30 * 24 * 60 * 60 * 1000; break;
        }
        
        const currentExpiry = subscriptions[id].expiryTime || Date.now();
        subscriptions[id].expiryTime = currentExpiry + milliseconds;
        subscriptions[id].paid = true;
        subscriptions[id].expired = false;
        
        // Восстанавливаем если было уничтожено
        if (subscriptions[id].originalContent) {
            subscriptions[id].masterConfig = subscriptions[id].originalContent;
            subscriptions[id].content = subscriptions[id].originalContent;
            subscriptions[id].originalContent = null;
            
            if (subscriptions[id].devices) {
                for (const deviceId in subscriptions[id].devices) {
                    subscriptions[id].devices[deviceId].active = true;
                    subscriptions[id].devices[deviceId].config = subscriptions[id].masterConfig;
                }
            }
        }
        
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/set-traffic/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        subscriptions[id].trafficLimit = req.body.limit;
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/templates/:type', isAuthenticated, (req, res) => {
    const type = req.params.type;
    res.json(templates[type] || []);
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        res.json(subscriptions[id].devices || {});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].owner === req.session.userId && 
        subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
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
    if (subscriptions[linkId] && subscriptions[linkId].owner === req.session.userId && 
        subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
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

app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        let deviceId = req.query.deviceId;
        
        if (!deviceId) {
            deviceId = uuidv4();
            return res.redirect(`/p/${id}?deviceId=${deviceId}`);
        }
        
        subscriptions[id].count++;
        
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const country = await getCountryFromIP(ip);
        
        if (!subscriptions[id].devices) {
            subscriptions[id].devices = {};
        }
        
        if (!subscriptions[id].devices[deviceId]) {
            subscriptions[id].devices[deviceId] = {
                name: country,
                ip: ip,
                userAgent: req.headers['user-agent'],
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                active: true,
                config: subscriptions[id].masterConfig || subscriptions[id].content
            };
        } else {
            subscriptions[id].devices[deviceId].lastSeen = new Date().toISOString();
            subscriptions[id].devices[deviceId].ip = ip;
        }
        
        // Учет трафика (примерно)
        if (subscriptions[id].trafficLimit) {
            subscriptions[id].totalTraffic = (subscriptions[id].totalTraffic || 0) + 0.1;
        }
        
        saveToGist();
        
        const device = subscriptions[id].devices[deviceId];
        const configToSend = device.active ? device.config : DESTROY_CONFIG;
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(configToSend);
    } else {
        res.status(404).send('Link not found');
    }
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        delete subscriptions[id];
        saveToGist();
    }
    res.redirect('/');
});

app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId) {
        if (!subscriptions[id].originalContent) {
            subscriptions[id].originalContent = subscriptions[id].masterConfig || subscriptions[id].content;
        }
        subscriptions[id].masterConfig = addPrefix(DESTROY_CONFIG);
        subscriptions[id].content = addPrefix(DESTROY_CONFIG);
        
        if (subscriptions[id].devices) {
            for (const deviceId in subscriptions[id].devices) {
                subscriptions[id].devices[deviceId].active = false;
                subscriptions[id].devices[deviceId].config = DESTROY_CONFIG;
            }
        }
        
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].owner === req.session.userId && subscriptions[id].originalContent) {
        subscriptions[id].masterConfig = subscriptions[id].originalContent;
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        
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

// ==================== АДМИНСКИЕ ФУНКЦИИ ====================
app.get('/admin/user-content/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    const userLinks = {};
    
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner === username) {
            userLinks[id] = data;
        }
    }
    
    res.json({links: userLinks});
});

app.post('/admin/login-as/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    if (users[username]) {
        req.session.authenticated = true;
        req.session.userId = username;
        req.session.adminSession = true;
        res.json({success: true});
    } else {
        res.status(404).json({error: 'User not found'});
    }
});

app.post('/admin/warn/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { message } = req.body;
    
    if (!users[username].warnings) {
        users[username].warnings = [];
    }
    
    users[username].warnings.push({
        message,
        date: new Date().toISOString(),
        from: req.session.userId
    });
    
    saveUsers();
    res.json({success: true});
});

app.post('/admin/block/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { reason, duration, value } = req.body;
    
    let until = null;
    let permanent = duration === 'permanent';
    
    if (!permanent) {
        let milliseconds = 0;
        switch(duration) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
        }
        until = new Date(Date.now() + milliseconds);
    }
    
    blockedUsers[username] = {
        reason,
        until,
        permanent,
        blockedAt: new Date().toISOString(),
        blockedBy: req.session.userId
    };
    
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/unblock/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    delete blockedUsers[username];
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/freeze/:username', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const username = req.params.username;
    const { reason, duration, value } = req.body;
    
    let until = null;
    let permanent = duration === 'permanent';
    
    if (!permanent) {
        let milliseconds = 0;
        switch(duration) {
            case 'minutes': milliseconds = value * 60 * 1000; break;
            case 'hours': milliseconds = value * 60 * 60 * 1000; break;
            case 'days': milliseconds = value * 24 * 60 * 60 * 1000; break;
        }
        until = new Date(Date.now() + milliseconds);
    }
    
    frozenUsers[username] = {
        reason,
        until,
        permanent,
        frozenAt: new Date().toISOString(),
        frozenBy: req.session.userId
    };
    
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/unfreeze/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    delete frozenUsers[username];
    saveBlockedData();
    res.json({success: true});
});

app.post('/admin/delete-user/:username', isAuthenticated, isAdmin, (req, res) => {
    const username = req.params.username;
    
    // Удаляем все ссылки пользователя
    for (const [id, data] of Object.entries(subscriptions)) {
        if (data.owner === username) {
            delete subscriptions[id];
        }
    }
    
    // Удаляем пользователя
    delete users[username];
    delete blockedUsers[username];
    delete frozenUsers[username];
    
    saveUsers();
    saveBlockedData();
    saveToGist();
    
    res.json({success: true});
});

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    loadUsers();
    loadTemplates();
    loadBlockedData();
    await loadFromGist();
    console.log('✅ Система готова к работе');
});
