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

const upload = multer({ storage: multer.memoryStorage() });

// ==================== ЗАГРУЗКА ДАННЫХ ====================
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } else {
            // Создаем админа по умолчанию
            const hashedPassword = bcrypt.hashSync('123', 10);
            users = {
                'admin': {
                    username: 'admin',
                    password: hashedPassword,
                    createdAt: new Date().toISOString()
                }
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
    // Заменяем адрес и порт в конфиге на 0.0.0.0:443
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

// ==================== РАБОТА С GIST (DataBAse.json) ====================
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
            console.log('✅ Данные сохранены в Gist (DataBAse.json)');
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
                console.log(`✅ Загружено ${count} ссылок из Gist (DataBAse.json)`);
                return true;
            } else {
                console.log('⚠️ Файл DataBAse.json пуст, начинаем с чистого состояния');
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
    if (req.session.authenticated && req.session.userId) next();
    else res.redirect('/login');
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
        createdAt: new Date().toISOString()
    };
    
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== СТРАНИЦА ВХОДА ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'no_file' ? '❌ Файл не выбран' : 
                  req.query.error === 'invalid' ? '❌ Неверный формат файла' : 
                  req.query.error === 'auth' ? '❌ Неверный логин или пароль' : '';
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

// ==================== ГЕНЕРАЦИЯ QR-КОДА ====================
app.get('/qrcode/:id', isAuthenticated, async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        const url = `${req.protocol}://${req.get('host')}/p/${id}`;
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
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>🔗 Ссылка: /p/${id}</h2>
                        <img src="${qrCode}" alt="QR Code">
                        <br>
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
    const linksCount = Object.keys(subscriptions).length;
    
    for (const [id, data] of Object.entries(subscriptions)) {
        const shortContent = removePrefix(data.masterConfig || data.content).substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.masterConfig || data.content).length > 50 ? '...' : '');
        const devicesCount = data.devices ? Object.keys(data.devices).length : 0;
        
        linksHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px;">
                    <code style="color: #0f0; font-size: 16px;">🔗 /p/${id}</code>
                    <button onclick="copyToClipboard('${id}')" style="background: #1f6392; padding: 5px 10px;">📋 Копировать</button>
                    <button onclick="window.open('/qrcode/${id}', '_blank', 'width=400,height=500')" style="background: #ff9800; padding: 5px 10px;">📱 QR-код</button>
                </div>
                <div style="margin-bottom: 8px; color: #58a6ff;">📝 ${escapeHtml(displayContent)}</div>
                <div style="margin-bottom: 12px;">👥 ${data.count || 0} переходов | 📱 ${devicesCount} устройств</div>
                <div>
                    <button onclick="editLink('${id}')" style="background: #1f6392;">✏️ Изменить</button>
                    <button onclick="showDevices('${id}')" style="background: #6f42c1;">📱 Устройства</button>
                    <form action="/decrement/${id}" method="POST" style="display: inline;" onsubmit="event.preventDefault(); this.submit();">
                        <button type="submit" style="background: #ff9800;">➖ −1</button>
                    </form>
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
                input, textarea { padding: 10px; width: 100%; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; margin: 5px 0; }
                .generate { background: #238636; color: white; }
                .export { background: #1f6392; color: white; }
                .logout { background: #d32f2f; float: right; }
                .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
                .modal-content { background: #161b22; margin: 50px auto; padding: 20px; width: 80%; max-width: 600px; border-radius: 12px; }
                .close { color: #fff; float: right; font-size: 28px; cursor: pointer; }
                .device-item { padding: 10px; margin: 5px 0; background: #0d1117; border-radius: 6px; }
                .device-active { border-left: 4px solid #238636; }
                .device-inactive { border-left: 4px solid #d32f2f; opacity: 0.7; }
            </style>
            <script>
                function copyToClipboard(id) {
                    navigator.clipboard.writeText(window.location.origin + '/p/' + id);
                    alert('Ссылка скопирована!');
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
                                            Последняя активность: \${new Date(device.lastSeen).toLocaleString()}<br>
                                            Статус: \${device.active ? '✅ Активно' : '❌ Неактивно'}<br>
                                            \${device.active ? \`
                                                <button onclick="deactivateDevice('\${id}', '\${uuid}')" style="background: #d32f2f; margin-top: 5px;">
                                                    ➖ Деактивировать
                                                </button>
                                            \` : ''}
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
                    if (confirm('Деактивировать устройство?')) {
                        fetch('/deactivate-device/' + linkId + '/' + deviceId, {
                            method: 'POST'
                        }).then(() => {
                            closeModal();
                            location.reload();
                        });
                    }
                }
                
                function closeModal() {
                    document.getElementById('modal').style.display = 'none';
                }
            </script>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 20px;">
                <span style="font-size: 18px;">👤 ${req.session.userId}</span>
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
                <a href="/export-all"><button class="export">💾 Скачать все ссылки</button></a>
            </div>
            <div class="card">
                <h1>🔐 Создать ссылку</h1>
                <form action="/generate" method="POST" onsubmit="event.preventDefault(); this.submit();">
                    <textarea name="content" placeholder="Введите конфиг VPN" rows="4" required></textarea>
                    <button type="submit" class="generate">✨ Сгенерировать</button>
                </form>
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
        </body>
        </html>
    `);
});

// ==================== ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    const id = generateRandomId();
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content),
        content: addPrefix(req.body.content), // для обратной совместимости
        originalContent: null,
        count: 0,
        devices: {},
        owner: req.session.userId
    };
    saveToGist();
    res.redirect('/');
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
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
        device.name = device.name.replace(': Неактивно', '') + ': Неактивно';
        // Меняем адрес в персональном конфиге на 0.0.0.0:443
        device.config = replaceAddressInConfig(device.config, '0.0.0.0:443');
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        // Генерируем UUID для устройства если его нет
        let deviceId = req.query.deviceId;
        if (!deviceId) {
            deviceId = uuidv4();
            // Редирект на URL с UUID
            return res.redirect(`/p/${id}?deviceId=${deviceId}`);
        }
        
        subscriptions[id].count++;
        
        // Получаем IP пользователя
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const country = await getCountryFromIP(ip);
        
        // Проверяем, существует ли устройство
        if (!subscriptions[id].devices) {
            subscriptions[id].devices = {};
        }
        
        if (!subscriptions[id].devices[deviceId]) {
            // Создаем новое устройство с персональным конфигом
            subscriptions[id].devices[deviceId] = {
                name: country,
                ip: ip,
                userAgent: req.headers['user-agent'],
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                active: true,
                config: subscriptions[id].masterConfig || subscriptions[id].content // персональная копия конфига
            };
        } else {
            // Обновляем время последнего доступа
            subscriptions[id].devices[deviceId].lastSeen = new Date().toISOString();
            subscriptions[id].devices[deviceId].ip = ip;
        }
        
        saveToGist();
        
        // Отдаем персональный конфиг устройства
        const device = subscriptions[id].devices[deviceId];
        const configToSend = device.active ? device.config : DESTROY_CONFIG;
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(configToSend);
    } else {
        res.status(404).send('Link not found');
    }
});

app.post('/decrement/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].count > 0) {
        subscriptions[id].count--;
        saveToGist();
    }
    res.redirect('/');
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    delete subscriptions[req.params.id];
    saveToGist();
    res.redirect('/');
});

app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        if (!subscriptions[id].originalContent) {
            subscriptions[id].originalContent = subscriptions[id].masterConfig || subscriptions[id].content;
        }
        subscriptions[id].masterConfig = addPrefix(DESTROY_CONFIG);
        subscriptions[id].content = addPrefix(DESTROY_CONFIG);
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].originalContent) {
        subscriptions[id].masterConfig = subscriptions[id].originalContent;
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        saveToGist();
    }
    res.redirect('/');
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
    await loadFromGist();
});
