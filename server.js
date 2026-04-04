const express = require('express');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== КОНФИГУРАЦИЯ ====================
// ЗАМЕНИТЕ НА СВОИ ДАННЫЕ (ОПЦИОНАЛЬНО):
const GIST_ID = 'fe2b9abda4ee7cf16314d8422c97f933';           // ID вашего Gist (если не нужен - оставьте 'ВАШ_GIST_ID')
const GITHUB_TOKEN = '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';        // Токен GitHub (если не нужен - оставьте 'ВАШ_TOKEN')

// ==================== ПЕРЕМЕННЫЕ ====================
let subscriptions = {};
const BACKUP_FILE = './backup.json';
const PROFILE_PREFIX = '# profile-update-interval: 1\n';
const DESTROY_CONFIG = 'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=random&pbk=00000000000000000000000000000000000000000000&sid=0000000000000000&type=tcp&headerType=none#VLESS_Reality_Example';

// Настройка multer для приёма файлов
const upload = multer({ storage: multer.memoryStorage() });

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

// ==================== РАБОТА С GIST ====================
async function saveToGist() {
    if (!GIST_ID || GIST_ID === 'ВАШ_GIST_ID') return;
    
    try {
        await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: { 'subscriptions.json': { content: JSON.stringify(subscriptions, null, 2) } }
            })
        });
        console.log('✅ Сохранено в Gist');
    } catch (e) { console.error('❌ Gist save error:', e.message); }
}

async function loadFromGist() {
    if (!GIST_ID || GIST_ID === 'ВАШ_GIST_ID') return false;
    
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
        });
        const gist = await res.json();
        const content = gist.files?.['subscriptions.json']?.content;
        if (content) {
            subscriptions = JSON.parse(content);
            console.log(`✅ Загружено ${Object.keys(subscriptions).length} ссылок из Gist`);
            return true;
        }
    } catch (e) { console.error('❌ Gist load error:', e.message); }
    return false;
}

// ==================== MIDDLEWARE ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'vpn-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated) next();
    else res.redirect('/login');
}

// ==================== СТРАНИЦА ВХОДА С ВЫБОРОМ ЗАГРУЗКИ ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'no_file' ? '❌ Файл не выбран' : 
                  req.query.error === 'invalid' ? '❌ Неверный формат файла' : '';
    
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
                .file-input { background: #f7f7f7; }
                .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 8px; margin: 15px 0; font-size: 13px; color: #856404; }
                .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 VPN Админка</h1>
                
                ${error ? `<div class="warning error">${error}</div>` : ''}
                
                <div class="warning">
                    💡 <strong>Восстановление данных:</strong><br>
                    Если сервер сбросился, загрузите ранее сохранённый .txt файл
                </div>
                
                <h2>🔑 Вход</h2>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <button type="submit">Войти</button>
                </form>
                
                <div class="divider">━━━━━━ ИЛИ ━━━━━━</div>
                
                <h2>📂 Восстановление</h2>
                <form action="/restore-from-file" method="POST" enctype="multipart/form-data">
                    <input type="file" name="backupFile" accept=".txt" class="file-input" required>
                    <button type="submit">📂 Загрузить из .txt файла</button>
                </form>
                
                ${(GIST_ID && GIST_ID !== 'ВАШ_GIST_ID') ? `
                <form action="/restore-from-gist" method="POST">
                    <button type="submit" style="background: #28a745;">☁️ Загрузить из Gist</button>
                </form>
                ` : ''}
            </div>
        </body>
        </html>
    `);
});

// Обработчик входа
app.post('/login', (req, res) => {
    if (req.body.username === '123' && req.body.password === '123') {
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

// ==================== ВОССТАНОВЛЕНИЕ ИЗ ФАЙЛА ====================
app.post('/restore-from-file', upload.single('backupFile'), (req, res) => {
    try {
        if (!req.file) {
            console.log('❌ Файл не загружен');
            return res.redirect('/login?error=no_file');
        }
        
        const fileContent = req.file.buffer.toString('utf-8');
        const base64Match = fileContent.match(/\[ДАННЫЕ В BASE64\]\n([A-Za-z0-9+/=]+)/);
        
        if (base64Match) {
            const jsonString = Buffer.from(base64Match[1], 'base64').toString('utf-8');
            const exportData = JSON.parse(jsonString);
            subscriptions = exportData.subscriptions;
            saveToGist();
            console.log(`✅ Восстановлено ${Object.keys(subscriptions).length} ссылок из файла`);
        } else {
            console.log('❌ Неверный формат файла');
            return res.redirect('/login?error=invalid');
        }
    } catch (e) {
        console.error('❌ Ошибка восстановления:', e.message);
        return res.redirect('/login?error=invalid');
    }
    res.redirect('/login');
});

// Восстановление из Gist
app.post('/restore-from-gist', async (req, res) => {
    await loadFromGist();
    res.redirect('/login');
});

// ==================== ЭКСПОРТ ВСЕХ ССЫЛОК ====================
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
Экспорт создан: ${new Date().toLocaleString()}
Всего ссылок: ${Object.keys(subscriptions).length}
========================

[ДАННЫЕ В BASE64]
${base64Data}

========================
КАК ВОССТАНОВИТЬ:
1. Зайдите на сайт
2. На странице входа нажмите "Загрузить из .txt файла"
3. Выберите этот файл
========================
`;
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=vpn-backup-${Date.now()}.txt`);
    res.send(fileContent);
});

// ==================== ОСНОВНОЙ ДАШБОРД ====================
app.get('/', isAuthenticated, (req, res) => {
    let linksHtml = '';
    const linksCount = Object.keys(subscriptions).length;
    
    for (const [id, data] of Object.entries(subscriptions)) {
        const shortContent = removePrefix(data.content).substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.content).length > 50 ? '...' : '');
        
        linksHtml += `
            <div style="margin: 10px 0; padding: 15px; border: 1px solid #333; background: #1e1e1e; border-radius: 8px;">
                <div style="margin-bottom: 8px;">
                    <code style="color: #0f0; font-size: 16px;">🔗 /p/${id}</code>
                    <button onclick="copyToClipboard('${id}')" style="background: #1f6392; padding: 5px 10px; font-size: 12px;">📋 Копировать</button>
                </div>
                <div style="margin-bottom: 8px; color: #58a6ff;">📝 ${escapeHtml(displayContent)}</div>
                <div style="margin-bottom: 12px;">👥 ${data.count} переходов</div>
                <div>
                    <form action="/decrement/${id}" method="POST" style="display: inline;">
                        <button type="submit" style="background: #ff9800; padding: 6px 12px;">➖ −1</button>
                    </form>
                    <form action="/destroy/${id}" method="POST" style="display: inline;">
                        <button type="submit" style="background: #8b0000; padding: 6px 12px;" onclick="return confirm('Уничтожить подписку? Конфиг заменится на заглушку!')">💀 Уничтожить</button>
                    </form>
                    ${data.originalContent ? `
                    <form action="/restore/${id}" method="POST" style="display: inline;">
                        <button type="submit" style="background: #238636; padding: 6px 12px;">🔄 Восстановить</button>
                    </form>
                    ` : ''}
                    <form action="/delete/${id}" method="POST" style="display: inline;">
                        <button type="submit" style="background: #d32f2f; padding: 6px 12px;" onclick="return confirm('Удалить ссылку навсегда?')">🗑 Удалить</button>
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
            <title>VPN Админка - Управление</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #0d1117; color: #fff; }
                .card { background: #161b22; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
                button { padding: 10px; margin: 5px; border-radius: 6px; border: none; cursor: pointer; }
                input { padding: 10px; width: 300px; background: #0d1117; color: #fff; border: 1px solid #333; border-radius: 6px; }
                .generate { background: #238636; color: white; }
                .export { background: #1f6392; color: white; }
                .logout { background: #d32f2f; float: right; }
                .stats { color: #58a6ff; font-size: 14px; margin-top: 10px; }
            </style>
            <script>
                function copyToClipboard(id) {
                    const url = window.location.origin + '/p/' + id;
                    navigator.clipboard.writeText(url);
                    alert('Ссылка скопирована: ' + url);
                }
            </script>
        </head>
        <body>
            <div style="overflow: hidden; margin-bottom: 20px;">
                <a href="/logout"><button class="logout">🚪 Выйти</button></a>
                <a href="/export-all"><button class="export">💾 Скачать все ссылки (base64)</button></a>
            </div>
            
            <div class="card">
                <h1>🔐 Создать новую ссылку</h1>
                <form action="/generate" method="POST">
                    <input type="text" name="content" placeholder="Введите конфиг VPN" required>
                    <button type="submit" class="generate">✨ Сгенерировать</button>
                </form>
            </div>
            
            <div class="card">
                <h2>📋 Мои ссылки</h2>
                <div class="stats">📊 Всего ссылок: ${linksCount}</div>
                ${linksHtml || '<p style="text-align: center; padding: 40px;">📭 Нет ссылок. Создайте первую!</p>'}
            </div>
        </body>
        </html>
    `);
});

// ==================== ОСТАЛЬНЫЕ ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    const id = generateRandomId();
    subscriptions[id] = {
        content: addPrefix(req.body.content),
        originalContent: null,
        count: 0
    };
    saveToGist();
    res.redirect('/');
});

app.get('/p/:id', (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].count++;
        saveToGist();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(subscriptions[id].content);
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
            subscriptions[id].originalContent = subscriptions[id].content;
        }
        subscriptions[id].content = addPrefix(DESTROY_CONFIG);
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].originalContent) {
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        saveToGist();
    }
    res.redirect('/');
});

// Функция для экранирования HTML
function escapeHtml(text) {
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ==================== ЗАПУСК СЕРВЕРА ====================
app.listen(PORT, async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🔐 Логин: 123, Пароль: 123`);
    await loadFromGist();
});
