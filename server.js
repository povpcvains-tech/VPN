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
const GIST_ID = process.env.GIST_ID || 'fe2b9abda4ee7cf16314d8422c97f933';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';

// ==================== ПЕРЕМЕННЫЕ ====================
let subscriptions = {};
let users = {};
let isDataLoaded = false;
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
            const hashedPassword = bcrypt.hashSync('123', 10);
            const hashedBase64 = bcrypt.hashSync('5382197', 10);
            users = {
                'admin': { username: 'admin', password: hashedPassword, createdAt: new Date().toISOString(), role: 'admin', blocked: false, frozen: false, linksCreated: 0, hasPremium: true },
                'base64': { username: 'base64', password: hashedBase64, createdAt: new Date().toISOString(), role: 'superadmin', blocked: false, frozen: false, linksCreated: 0, hasPremium: true }
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
        // Миграция
        let migrated = false;
        for (const username in users) {
            if (!users[username].role) { users[username].role = 'user'; migrated = true; }
            if (users[username].blocked === undefined) { 
                users[username].blocked = false; users[username].frozen = false; 
                users[username].linksCreated = 0; users[username].hasPremium = false;
                migrated = true; 
            }
        }
        if (migrated) saveUsers();
    } catch (error) { console.error('❌ Error loading users:', error.message); }
}

function saveUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } 
    catch (error) { console.error('❌ Error saving users:', error.message); }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function generateRandomId() { return Math.random().toString(36).substring(2, 8); }
function addPrefix(content) { return content.startsWith(PROFILE_PREFIX) ? content : PROFILE_PREFIX + content; }
function removePrefix(content) { return content.startsWith(PROFILE_PREFIX) ? content.substring(PROFILE_PREFIX.length) : content; }
function replaceAddressInConfig(config, newAddress) { return config.replace(/@[\d\.]+:\d+/, `@${newAddress}`); }

async function getCountryFromIP(ip) {
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 3000 });
        if (response.data.status === 'success') return response.data.country;
    } catch (error) { /* ignore */ }
    return 'Unknown';
}

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

function isSubscriptionExpired(sub) { return sub.expiryDate && new Date() > new Date(sub.expiryDate); }

function isTrafficLimitExceeded(sub) {
    if (!sub.trafficLimit || sub.trafficLimit <= 0) return false;
    let total = 0;
    if (sub.devices) for (const d of Object.values(sub.devices)) total += (d.trafficUsed || 0);
    return total >= sub.trafficLimit;
}

function isDeviceLimitExceeded(sub) {
    if (!sub.maxDevices || sub.maxDevices <= 0) return false;
    return (sub.devices ? Object.keys(sub.devices).length : 0) >= sub.maxDevices;
}

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

// 🔥 ИСПРАВЛЕНИЕ БАГА: Обновляет конфиг для всех активных устройств при изменении мастер-конфига
function updateAllDevicesConfig(subId) {
    const sub = subscriptions[subId];
    if (!sub || !sub.devices) return;
    for (const deviceId in sub.devices) {
        if (sub.devices[deviceId].active && !sub.isDestroyed) {
            sub.devices[deviceId].config = sub.masterConfig;
        }
    }
}

function checkSubscriptions() {
    let changed = false;
    for (const [id, sub] of Object.entries(subscriptions)) {
        if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
            console.log(`🔥 Sub ${id} expired/limit -> Destroy`);
            if (!sub.originalContent) sub.originalContent = sub.masterConfig;
            applyDestroyConfig(sub);
            changed = true;
        }
    }
    if (changed) saveToGist();
}
setInterval(checkSubscriptions, 5 * 60 * 1000);

// ==================== GIST OPERATIONS ====================
async function saveToGist() {
    if (!isDataLoaded) return;
    console.log('💾 Saving to Gist...');
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { 'DataBAse.json': { content: JSON.stringify(subscriptions, null, 2) } } })
        });
        if (!response.ok) throw new Error(`API ${response.status}`);
    } catch (error) {
        console.error('❌ Gist Save Error:', error.message);
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(subscriptions, null, 2));
    }
}

async function loadFromGist() {
    console.log('📥 Loading from Gist...');
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
        });
        if (response.ok) {
            const gist = await response.json();
            const content = gist.files?.['DataBAse.json']?.content;
            if (content) {
                subscriptions = JSON.parse(content);
                // Миграция данных
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) data.masterConfig = data.content;
                    if (!data.devices) data.devices = {};
                    if (!data.name) data.name = `Sub #${id}`;
                    if (!data.trafficLimit) data.trafficLimit = 0;
                    if (!data.maxDevices) data.maxDevices = 0;
                    if (!data.owner) data.owner = 'admin';
                }
                console.log(`✅ Loaded ${Object.keys(subscriptions).length} subs`);
                isDataLoaded = true;
                return true;
            }
        }
        throw new Error('No content');
    } catch (error) {
        console.error('❌ Gist Load Error:', error.message);
        if (fs.existsSync(BACKUP_FILE)) {
            try {
                subscriptions = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
                isDataLoaded = true;
                console.log('📁 Loaded from backup');
                return true;
            } catch (e) { console.error('❌ Backup error'); }
        }
        isDataLoaded = true; 
        return false;
    }
}

// ==================== MIDDLEWARE ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'vpn-secret-v1.8-full',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

app.get('/health', (req, res) => res.json({ status: 'ok', loaded: isDataLoaded }));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated && req.session.userId && users[req.session.userId]) {
        if (users[req.session.userId].blocked || users[req.session.userId].frozen) { 
            req.session.destroy(); return res.redirect('/login?error=blocked'); 
        }
        next();
    } else { res.redirect('/login'); }
}

function isAdmin(req, res, next) {
    const r = users[req.session.userId]?.role;
    if (r === 'admin' || r === 'superadmin') next(); else res.status(403).send('Access Denied');
}

// ==================== РЕГИСТРАЦИЯ ====================
app.get('/register', (req, res) => {
    const error = req.query.error || '';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Register</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}</style></head>
    <body><div class="c"><h1>📝 Register</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form action="/register" method="POST">
        <input type="text" name="username" placeholder="Login (min 3 chars)" required minlength="3">
        <input type="password" name="password" placeholder="Password (min 6 chars)" required minlength="6">
        <input type="password" name="confirm_password" placeholder="Confirm Password" required>
        <button type="submit">Register</button>
    </form>
    <div class="link"><a href="/login">← Back to Login</a></div></div></body></html>`);
});

app.post('/register', (req, res) => {
    const { username, password, confirm_password } = req.body;
    if (password !== confirm_password) return res.redirect('/register?error=Passwords do not match');
    if (username.length < 3 || password.length < 6) return res.redirect('/register?error=Login min 3, Password min 6');
    if (users[username]) return res.redirect('/register?error=User already exists');
    
    users[username] = {
        username, password: bcrypt.hashSync(password, 10),
        createdAt: new Date().toISOString(), role: 'user',
        blocked: false, frozen: false, linksCreated: 0, hasPremium: false
    };
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== ВХОД ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'auth' ? '❌ Wrong login/password' : 
                  req.query.error === 'blocked' ? '🚫 Account blocked' : '';
    const registered = req.query.registered === 'true' ? '✅ Registered! Please login.' : '';
    
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}
    .success{background:#d4edda;color:#155724;padding:10px;border-radius:8px;margin-bottom:15px;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}</style></head>
    <body><div class="c"><h1>🔐 VPN Admin</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${registered ? `<div class="success">${registered}</div>` : ''}
    <form action="/login" method="POST">
        <input type="text" name="username" placeholder="Login" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
    </form>
    <div class="link"><a href="/register">📝 Create Account</a></div></div></body></html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (users[username] && bcrypt.compareSync(password, users[username].password)) {
        if (users[username].blocked) return res.redirect('/login?error=blocked');
        req.session.authenticated = true; 
        req.session.userId = username;
        res.redirect('/');
    } else { 
        res.redirect('/login?error=auth'); 
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==================== СМЕНА ПАРОЛЯ ====================
app.get('/change-password', isAuthenticated, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Change Password</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}</style></head>
    <body><div class="c"><h1>🔑 Change Password</h1><div id="msg"></div>
    <input type="password" id="cur" placeholder="Current Password">
    <input type="password" id="newp" placeholder="New Password">
    <input type="password" id="conf" placeholder="Confirm New Password">
    <button onclick="submitPass()">Save</button>
    <div class="link"><a href="/">Back</a></div></div>
    <script>async function submitPass(){
        const c=document.getElementById('cur').value,n=document.getElementById('newp').value,co=document.getElementById('conf').value;
        if(n!==co)return document.getElementById('msg').innerHTML='<div class="error">Passwords mismatch</div>';
        const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:c,newpass:n})});
        const d=await r.json();
        if(d.success){alert('✅ Password changed!');window.location.href='/';} 
        else {document.getElementById('msg').innerHTML='<div class="error">'+d.error+'</div>';}
    }</script></body></html>`);
});

app.post('/api/change-password', isAuthenticated, express.json(), (req, res) => {
    const { current, newpass } = req.body;
    const user = users[req.session.userId];
    if (!bcrypt.compareSync(current, user.password)) return res.json({success: false, error: 'Wrong current password'});
    user.password = bcrypt.hashSync(newpass, 10);
    saveUsers();
    res.json({success: true});
});

// ==================== ГЛАВНЫЙ ДАШБОРД (ПОЛНАЯ ВЕРСИЯ) ====================
app.get('/', isAuthenticated, (req, res) => {
    if (!isDataLoaded) return res.send('<h1 style="color:white;text-align:center;padding:50px;">⏳ Loading data... Please refresh in 5 seconds.</h1><script>setTimeout(()=>location.reload(), 5000);</script>');
    
    const currentUser = users[req.session.userId];
    const isSuperAdmin = currentUser?.role === 'superadmin';
    let linksHtml = '';
    const allLinks = Object.entries(subscriptions);
    const visibleLinks = isSuperAdmin ? allLinks : allLinks.filter(([_, s]) => s.owner === req.session.userId);
    
    for (const [id, data] of visibleLinks) {
        const status = data.isDestroyed ? '💀 DESTROYED' : 
                       (isSubscriptionExpired(data) ? '⏰ EXPIRED' : 
                       (isTrafficLimitExceeded(data) ? '📊 TRAFFIC LIMIT' : '✅ ACTIVE'));
        const statusColor = data.isDestroyed || isSubscriptionExpired(data) ? '#d32f2f' : '#238636';
        
        linksHtml += `
            <div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <code style="color:#0f0;font-size:16px;">🔗 /p/${id}</code>
                    <span style="color:${statusColor};font-weight:bold;">${status}</span>
                </div>
                <div style="color:#8b949e;font-size:13px;margin-bottom:10px;">
                    📝 ${data.name || 'No Name'} | 👤 ${data.owner} | 📱 ${Object.keys(data.devices||{}).length}/${data.maxDevices || '∞'} | 
                    ⏰ ${data.expiryDate ? new Date(data.expiryDate).toLocaleDateString() : '∞'} |
                    🌐 ${data.trafficLimit ? ((Object.values(data.devices||{}).reduce((s,d)=>s+(d.trafficUsed||0),0)/data.trafficLimit*100).toFixed(1)+'%') : '∞'}
                </div>
                <div>
                    <button onclick="window.extendSubscription('${id}')" style="background:#238636;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;font-weight:bold;">💰 Продлить</button>
                    <button onclick="window.copyLink('${id}')" style="background:#1f6392;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">📋 Копировать</button>
                    <button onclick="window.showQR('${id}')" style="background:#ff9800;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">📱 QR</button>
                    <button onclick="window.showDevices('${id}')" style="background:#6f42c1;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">👁 Устройства</button>
                    <button onclick="window.editSub('${id}')" style="background:#1f6392;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">✏️ Изм.</button>
                    <button onclick="window.deleteSub('${id}')" style="background:#d32f2f;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">🗑 Удалить</button>
                </div>
            </div>`;
    }
    
    const adminBtn = isSuperAdmin ? '<a href="/admin/users" style="float:right;margin-right:10px;color:#fff;text-decoration:none;"><button style="background:#8b4513;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;">👥 Users</button></a>' : '';

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>VPN Admin Full</title>
    <style>body{font-family:Arial;padding:20px;background:#0d1117;color:#fff;}
    .card{background:#161b22;padding:20px;border-radius:12px;margin-bottom:20px;}
    button{padding:8px 12px;margin:5px;border-radius:6px;border:none;cursor:pointer;}
    input,textarea,select{padding:10px;width:100%;background:#0d1117;color:#fff;border:1px solid #333;border-radius:6px;margin:5px 0;box-sizing:border-box;}
    .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;}
    .modal-content{background:#161b22;margin:5% auto;padding:20px;width:90%;max-width:500px;border-radius:12px;max-height:80vh;overflow-y:auto;}
    .close{color:#fff;float:right;font-size:24px;cursor:pointer;}
    .dev-item{background:#0d1117;padding:10px;margin:5px 0;border-radius:6px;border-left:3px solid #238636;}</style></head>
    <body>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="margin:0;">👤 ${req.session.userId}</h2>
            <div>${adminBtn}
            <a href="/change-password"><button style="background:#8b4513;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;margin-right:5px;">🔑 Pass</button></a>
            <a href="/export-all"><button style="background:#1f6392;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;margin-right:5px;">💾 Export</button></a>
            <a href="/logout"><button style="background:#d32f2f;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;">🚪 Logout</button></a></div>
        </div>
        
        <div class="card">
            <h1>✨ Создать подписку</h1>
            <form action="/generate" method="POST">
                <input type="text" name="name" placeholder="Название подписки" required>
                <textarea name="content" placeholder="Вставьте конфиг VLESS/Trojan..." rows="3" required></textarea>
                <div style="display:flex;gap:10px;">
                    <input type="number" name="duration" value="30" min="1" style="width:30%;">
                    <select name="unit" style="width:30%;"><option value="days" selected>Дней</option><option value="hours">Часов</option><option value="months">Месяцев</option></select>
                </div>
                <div style="display:flex;gap:10px;">
                    <input type="number" name="maxDevices" value="0" min="0" placeholder="Max Devices (0=∞)" style="width:48%;">
                    <input type="number" name="trafficLimit" value="0" min="0" placeholder="Traffic MB (0=∞)" style="width:48%;">
                </div>
                <button type="submit" style="background:#238636;color:white;padding:12px;width:100%;font-weight:bold;margin-top:10px;">✨ Создать</button>
            </form>
        </div>
        
        <div class="card">
            <h2>📋 Мои подписки</h2>
            ${linksHtml || '<p style="color:#8b949e;">Нет подписок.</p>'}
        </div>
        
        <!-- МОДАЛЬНОЕ ОКНО -->
        <div id="mainModal" class="modal"><div class="modal-content"><span class="close" onclick="document.getElementById('mainModal').style.display='none'">&times;</span><div id="modalBody"></div></div></div>
        
        <script>
            window.copyLink = function(id) {
                const url = window.location.origin + '/p/' + id;
                navigator.clipboard.writeText(url).then(() => alert('✅ Copied!'));
            };
            
            window.deleteSub = function(id) {
                if(confirm('Delete ' + id + '?')) fetch('/delete/' + id, { method: 'POST' }).then(() => location.reload());
            };

            window.showQR = function(id) {
                window.open('/generate-qrcode/' + id, '_blank', 'width=400,height=500');
            };

            window.editSub = function(id) {
                const newConf = prompt('Enter new config:');
                if(newConf) fetch('/edit/' + id, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: newConf}) }).then(() => location.reload());
            };

            window.showDevices = function(id) {
                fetch('/devices/' + id).then(r => r.json()).then(devs => {
                    let html = '<h3>📱 Devices for ' + id + '</h3>';
                    for(const [uuid, d] of Object.entries(devs)) {
                        html += '<div class="dev-item" style="border-color:' + (d.active ? '#238636' : '#d32f2f') + '">';
                        html += '<b>' + (d.name||'Unknown') + '</b><br>';
                        html += 'IP: ' + d.ip + '<br>';
                        html += 'Country: ' + (d.country||'Unknown') + '<br>';
                        html += 'Traffic: ' + ((d.trafficUsed||0)/1024/1024).toFixed(2) + ' MB<br>';
                        html += 'Status: ' + (d.active ? 'Active' : 'Inactive');
                        if(!d.active) html += ' <button onclick="restoreDev(\''+id+'\',\''+uuid+'\')" style="background:#238636;color:white;border:none;padding:2px 5px;border-radius:3px;">Restore</button>';
                        else html += ' <button onclick="killDev(\''+id+'\',\''+uuid+'\')" style="background:#d32f2f;color:white;border:none;padding:2px 5px;border-radius:3px;">Kill</button>';
                        html += '</div>';
                    }
                    document.getElementById('modalBody').innerHTML = html;
                    document.getElementById('mainModal').style.display = 'block';
                });
            };

            window.killDev = function(id, uuid) {
                fetch('/deactivate-device/' + id + '/' + uuid, {method:'POST'}).then(() => window.showDevices(id));
            };
            window.restoreDev = function(id, uuid) {
                fetch('/restore-device/' + id + '/' + uuid, {method:'POST'}).then(() => window.showDevices(id));
            };

            window.extendSubscription = function(id) {
                const html = '<h3>💰 Продлить ' + id + '</h3>' +
                    '<p>Duration:</p><select id="extUnit"><option value="days" selected>Days</option><option value="hours">Hours</option><option value="months">Months</option></select>' +
                    '<input type="number" id="extValue" value="30" min="1">' +
                    '<p>Max Devices (0=∞):</p><input type="number" id="extDevices" value="0" min="0">' +
                    '<p>Traffic MB (0=∞):</p><input type="number" id="extTraffic" value="0" min="0">' +
                    '<button id="btnSubmit" style="background:#238636;color:white;width:100%;padding:12px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;margin-top:15px;">✅ Продлить</button>';
                
                document.getElementById('modalBody').innerHTML = html;
                document.getElementById('mainModal').style.display = 'block';
                
                document.getElementById('btnSubmit').onclick = function() {
                    window.submitExtension(id);
                };
            };

            window.submitExtension = function(id) {
                const btn = document.getElementById('btnSubmit');
                btn.innerHTML = '⏳ Processing...';
                btn.disabled = true;
                
                fetch('/api/extend/' + id, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        duration: parseInt(document.getElementById('extValue').value),
                        unit: document.getElementById('extUnit').value,
                        maxDevices: parseInt(document.getElementById('extDevices').value),
                        trafficLimit: parseInt(document.getElementById('extTraffic').value)
                    })
                })
                .then(r => r.json())
                .then(res => {
                    if(res.success) { alert('✅ Extended!'); location.reload(); } 
                    else { alert('❌ Error'); btn.disabled = false; btn.innerHTML = '✅ Extend'; }
                })
                .catch(e => { alert('❌ Network Error'); btn.disabled = false; btn.innerHTML = '✅ Extend'; });
            };
        </script>
    </body></html>`);
});

// ==================== API И МАРШРУТЫ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    if (!isDataLoaded) return res.status(503).send('Loading...');
    const id = generateRandomId();
    const duration = parseInt(req.body.duration) || 30;
    const unit = req.body.unit || 'days';
    const trafficLimit = parseInt(req.body.trafficLimit) || 0;
    const maxDevices = parseInt(req.body.maxDevices) || 0;
    
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content), content: addPrefix(req.body.content),
        originalContent: null, count: 0, devices: {},
        owner: req.session.userId, name: req.body.name || `Sub #${id}`,
        trafficLimit: trafficLimit > 0 ? trafficLimit * 1024 * 1024 : 0,
        maxDevices: maxDevices,
        expiryDate: calculateExpiryDate(duration, unit).toISOString(),
        isDestroyed: false, createdAt: new Date().toISOString()
    };
    if (users[req.session.userId]) { users[req.session.userId].linksCreated++; saveUsers(); }
    saveToGist();
    res.redirect('/');
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id]) { delete subscriptions[req.params.id]; saveToGist(); }
    res.redirect('/');
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        updateAllDevicesConfig(id); // 🔥 Обновляем для всех устройств
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id]) res.json(subscriptions[req.params.id].devices || {});
    else res.status(404).json({error: 'Not found'});
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId]?.devices?.[deviceId]) {
        subscriptions[linkId].devices[deviceId].active = false;
        subscriptions[linkId].devices[deviceId].config = DESTROY_CONFIG;
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.post('/restore-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId]?.devices?.[deviceId]) {
        subscriptions[linkId].devices[deviceId].active = true;
        subscriptions[linkId].devices[deviceId].config = subscriptions[linkId].masterConfig;
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.post('/api/extend/:id', isAuthenticated, express.json(), (req, res) => {
    if (!isDataLoaded) return res.status(503).json({error: 'Loading'});
    const { id } = req.params;
    const { duration, unit, maxDevices, trafficLimit } = req.body;
    const sub = subscriptions[id];
    
    if (sub && (sub.owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        sub.expiryDate = calculateExpiryDate(duration, unit).toISOString();
        if (maxDevices !== undefined) sub.maxDevices = parseInt(maxDevices);
        if (trafficLimit !== undefined) sub.trafficLimit = parseInt(trafficLimit) > 0 ? parseInt(trafficLimit) * 1024 * 1024 : 0;
        
        // 🔥 Восстановление если подписка была уничтожена
        if (sub.isDestroyed && sub.originalContent) {
            sub.masterConfig = sub.originalContent;
            sub.content = sub.originalContent;
            sub.isDestroyed = false;
            sub.originalContent = null;
            if (sub.devices) {
                for (const devId in sub.devices) {
                    sub.devices[devId].active = true;
                    sub.devices[devId].config = sub.masterConfig;
                }
            }
        }
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/generate-qrcode/:id', isAuthenticated, async (req, res) => {
    if (subscriptions[req.params.id]) {
        const newDeviceId = uuidv4();
        const url = `${req.protocol}://${req.get('host')}/p/${req.params.id}?deviceId=${newDeviceId}`;
        try {
            const qrCode = await QRCode.toDataURL(url);
            res.send(`<h2 style="text-align:center">QR Code</h2><div style="text-align:center"><img src="${qrCode}" style="background:white;padding:10px;border-radius:8px;"></div><p style="text-align:center;font-size:12px">UUID: ${newDeviceId}</p>`);
        } catch (e) { res.status(500).send('Error'); }
    } else res.status(404).send('Not found');
});

app.get('/admin/users', isAuthenticated, isAdmin, (req, res) => {
    let usersHtml = '';
    for (const [username, user] of Object.entries(users)) {
        const linksCount = Object.values(subscriptions).filter(s => s.owner === username).length;
        usersHtml += `<div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
            <strong>👤 ${username}</strong> (${user.role})<br>Links: ${linksCount} | Blocked: ${user.blocked}
            <div style="margin-top:5px;">
                ${user.blocked ? `<button onclick="unblock('${username}')" style="background:#238636;color:white;border:none;padding:5px;">Unblock</button>` : `<button onclick="block('${username}')" style="background:#d32f2f;color:white;border:none;padding:5px;">Block</button>`}
                <button onclick="delUser('${username}')" style="background:#d32f2f;color:white;border:none;padding:5px;">Delete</button>
            </div></div>`;
    }
    res.send(`<!DOCTYPE html><html><body style="background:#0d1117;color:white;padding:20px;">
    <h1>👥 User Management</h1><a href="/"><button style="background:#6e7681;color:white;border:none;padding:10px;">Back</button></a>
    ${usersHtml}
    <script>
        function block(u){fetch('/api/block-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}
        function unblock(u){fetch('/api/unblock-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}
        function delUser(u){if(confirm('Delete '+u+'?')){fetch('/api/delete-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}}
    </script></body></html>`);
});

app.post('/api/block-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]) { users[req.body.username].blocked=true; saveUsers(); } res.json({success:true}); });
app.post('/api/unblock-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]) { users[req.body.username].blocked=false; saveUsers(); } res.json({success:true}); });
app.post('/api/delete-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username } = req.body;
    if (username && username !== req.session.userId && users[username]) {
        for (const [id, sub] of Object.entries(subscriptions)) { if (sub.owner === username) delete subscriptions[id]; }
        delete users[username]; saveUsers(); saveToGist();
    } res.json({success:true}); 
});

app.get('/export-all', isAuthenticated, (req, res) => {
    const data = JSON.stringify({ version: '1.8', subscriptions }, null, 2);
    const b64 = Buffer.from(data).toString('base64');
    res.setHeader('Content-Disposition', 'attachment; filename=backup.txt');
    res.send(`VPN BACKUP\n[ДАННЫЕ В BASE64]\n${b64}`);
});

// ==================== ПОТРЕБИТЕЛЬСКАЯ ССЫЛКА (/p/:id) ====================
app.get('/p/:id', async (req, res) => {
    if (!isDataLoaded) return res.status(503).send('# Server initializing...');
    const id = req.params.id;
    if (!subscriptions[id]) return res.status(404).send('Not found');
    
    const sub = subscriptions[id];
    let deviceId = req.query.deviceId;
    if (!deviceId) { deviceId = uuidv4(); return res.redirect(`/p/${id}?deviceId=${deviceId}`); }
    
    sub.count = (sub.count || 0) + 1;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || '0.0.0.0';
    const country = await getCountryFromIP(ip);
    
    if (!sub.devices) sub.devices = {};
    
    if (!sub.devices[deviceId]) {
        if (isDeviceLimitExceeded(sub)) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(DESTROY_CONFIG); 
        }
        sub.devices[deviceId] = {
            name: country, country, ip,
            userAgent: req.headers['user-agent'],
            firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
            active: true, config: sub.masterConfig || sub.content, trafficUsed: 0
        };
    } else {
        const device = sub.devices[deviceId];
        device.lastSeen = new Date().toISOString();
        device.ip = ip;
        if (device.country !== country) device.country = country;
        // 🔥 Обновляем конфиг для устройства, если мастер-конфиг изменился
        if (device.active && !sub.isDestroyed && device.config !== sub.masterConfig) device.config = sub.masterConfig;
        device.trafficUsed = (device.trafficUsed || 0) + Buffer.byteLength(device.config, 'utf8');
    }
    
    if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
        if (!sub.originalContent) sub.originalContent = sub.masterConfig;
        applyDestroyConfig(sub);
    }
    
    saveToGist();
    
    const device = sub.devices[deviceId];
    const configToSend = (device?.active && !sub.isDestroyed) ? device.config : DESTROY_CONFIG;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(configToSend);
});

// ==================== ЗАПУСК ====================
loadUsers();

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await loadFromGist();
    checkSubscriptions();
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
const GIST_ID = process.env.GIST_ID || 'fe2b9abda4ee7cf16314d8422c97f933';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';

// ==================== ПЕРЕМЕННЫЕ ====================
let subscriptions = {};
let users = {};
let isDataLoaded = false;
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
            const hashedPassword = bcrypt.hashSync('123', 10);
            const hashedBase64 = bcrypt.hashSync('5382197', 10);
            users = {
                'admin': { username: 'admin', password: hashedPassword, createdAt: new Date().toISOString(), role: 'admin', blocked: false, frozen: false, linksCreated: 0, hasPremium: true },
                'base64': { username: 'base64', password: hashedBase64, createdAt: new Date().toISOString(), role: 'superadmin', blocked: false, frozen: false, linksCreated: 0, hasPremium: true }
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
        // Миграция
        let migrated = false;
        for (const username in users) {
            if (!users[username].role) { users[username].role = 'user'; migrated = true; }
            if (users[username].blocked === undefined) { 
                users[username].blocked = false; users[username].frozen = false; 
                users[username].linksCreated = 0; users[username].hasPremium = false;
                migrated = true; 
            }
        }
        if (migrated) saveUsers();
    } catch (error) { console.error('❌ Error loading users:', error.message); }
}

function saveUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } 
    catch (error) { console.error('❌ Error saving users:', error.message); }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function generateRandomId() { return Math.random().toString(36).substring(2, 8); }
function addPrefix(content) { return content.startsWith(PROFILE_PREFIX) ? content : PROFILE_PREFIX + content; }
function removePrefix(content) { return content.startsWith(PROFILE_PREFIX) ? content.substring(PROFILE_PREFIX.length) : content; }
function replaceAddressInConfig(config, newAddress) { return config.replace(/@[\d\.]+:\d+/, `@${newAddress}`); }

async function getCountryFromIP(ip) {
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 3000 });
        if (response.data.status === 'success') return response.data.country;
    } catch (error) { /* ignore */ }
    return 'Unknown';
}

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

function isSubscriptionExpired(sub) { return sub.expiryDate && new Date() > new Date(sub.expiryDate); }

function isTrafficLimitExceeded(sub) {
    if (!sub.trafficLimit || sub.trafficLimit <= 0) return false;
    let total = 0;
    if (sub.devices) for (const d of Object.values(sub.devices)) total += (d.trafficUsed || 0);
    return total >= sub.trafficLimit;
}

function isDeviceLimitExceeded(sub) {
    if (!sub.maxDevices || sub.maxDevices <= 0) return false;
    return (sub.devices ? Object.keys(sub.devices).length : 0) >= sub.maxDevices;
}

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

// 🔥 ИСПРАВЛЕНИЕ БАГА: Обновляет конфиг для всех активных устройств при изменении мастер-конфига
function updateAllDevicesConfig(subId) {
    const sub = subscriptions[subId];
    if (!sub || !sub.devices) return;
    for (const deviceId in sub.devices) {
        if (sub.devices[deviceId].active && !sub.isDestroyed) {
            sub.devices[deviceId].config = sub.masterConfig;
        }
    }
}

function checkSubscriptions() {
    let changed = false;
    for (const [id, sub] of Object.entries(subscriptions)) {
        if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
            console.log(`🔥 Sub ${id} expired/limit -> Destroy`);
            if (!sub.originalContent) sub.originalContent = sub.masterConfig;
            applyDestroyConfig(sub);
            changed = true;
        }
    }
    if (changed) saveToGist();
}
setInterval(checkSubscriptions, 5 * 60 * 1000);

// ==================== GIST OPERATIONS ====================
async function saveToGist() {
    if (!isDataLoaded) return;
    console.log('💾 Saving to Gist...');
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { 'DataBAse.json': { content: JSON.stringify(subscriptions, null, 2) } } })
        });
        if (!response.ok) throw new Error(`API ${response.status}`);
    } catch (error) {
        console.error('❌ Gist Save Error:', error.message);
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(subscriptions, null, 2));
    }
}

async function loadFromGist() {
    console.log('📥 Loading from Gist...');
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
        });
        if (response.ok) {
            const gist = await response.json();
            const content = gist.files?.['DataBAse.json']?.content;
            if (content) {
                subscriptions = JSON.parse(content);
                // Миграция данных
                for (const [id, data] of Object.entries(subscriptions)) {
                    if (!data.masterConfig && data.content) data.masterConfig = data.content;
                    if (!data.devices) data.devices = {};
                    if (!data.name) data.name = `Sub #${id}`;
                    if (!data.trafficLimit) data.trafficLimit = 0;
                    if (!data.maxDevices) data.maxDevices = 0;
                    if (!data.owner) data.owner = 'admin';
                }
                console.log(`✅ Loaded ${Object.keys(subscriptions).length} subs`);
                isDataLoaded = true;
                return true;
            }
        }
        throw new Error('No content');
    } catch (error) {
        console.error('❌ Gist Load Error:', error.message);
        if (fs.existsSync(BACKUP_FILE)) {
            try {
                subscriptions = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
                isDataLoaded = true;
                console.log('📁 Loaded from backup');
                return true;
            } catch (e) { console.error('❌ Backup error'); }
        }
        isDataLoaded = true; 
        return false;
    }
}

// ==================== MIDDLEWARE ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'vpn-secret-v1.8-full',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

app.get('/health', (req, res) => res.json({ status: 'ok', loaded: isDataLoaded }));

function isAuthenticated(req, res, next) {
    if (req.session.authenticated && req.session.userId && users[req.session.userId]) {
        if (users[req.session.userId].blocked || users[req.session.userId].frozen) { 
            req.session.destroy(); return res.redirect('/login?error=blocked'); 
        }
        next();
    } else { res.redirect('/login'); }
}

function isAdmin(req, res, next) {
    const r = users[req.session.userId]?.role;
    if (r === 'admin' || r === 'superadmin') next(); else res.status(403).send('Access Denied');
}

// ==================== РЕГИСТРАЦИЯ ====================
app.get('/register', (req, res) => {
    const error = req.query.error || '';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Register</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}</style></head>
    <body><div class="c"><h1>📝 Register</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form action="/register" method="POST">
        <input type="text" name="username" placeholder="Login (min 3 chars)" required minlength="3">
        <input type="password" name="password" placeholder="Password (min 6 chars)" required minlength="6">
        <input type="password" name="confirm_password" placeholder="Confirm Password" required>
        <button type="submit">Register</button>
    </form>
    <div class="link"><a href="/login">← Back to Login</a></div></div></body></html>`);
});

app.post('/register', (req, res) => {
    const { username, password, confirm_password } = req.body;
    if (password !== confirm_password) return res.redirect('/register?error=Passwords do not match');
    if (username.length < 3 || password.length < 6) return res.redirect('/register?error=Login min 3, Password min 6');
    if (users[username]) return res.redirect('/register?error=User already exists');
    
    users[username] = {
        username, password: bcrypt.hashSync(password, 10),
        createdAt: new Date().toISOString(), role: 'user',
        blocked: false, frozen: false, linksCreated: 0, hasPremium: false
    };
    saveUsers();
    res.redirect('/login?registered=true');
});

// ==================== ВХОД ====================
app.get('/login', (req, res) => {
    const error = req.query.error === 'auth' ? '❌ Wrong login/password' : 
                  req.query.error === 'blocked' ? '🚫 Account blocked' : '';
    const registered = req.query.registered === 'true' ? '✅ Registered! Please login.' : '';
    
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}
    .success{background:#d4edda;color:#155724;padding:10px;border-radius:8px;margin-bottom:15px;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}</style></head>
    <body><div class="c"><h1>🔐 VPN Admin</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${registered ? `<div class="success">${registered}</div>` : ''}
    <form action="/login" method="POST">
        <input type="text" name="username" placeholder="Login" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
    </form>
    <div class="link"><a href="/register">📝 Create Account</a></div></div></body></html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (users[username] && bcrypt.compareSync(password, users[username].password)) {
        if (users[username].blocked) return res.redirect('/login?error=blocked');
        req.session.authenticated = true; 
        req.session.userId = username;
        res.redirect('/');
    } else { 
        res.redirect('/login?error=auth'); 
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==================== СМЕНА ПАРОЛЯ ====================
app.get('/change-password', isAuthenticated, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Change Password</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .c{background:white;border-radius:16px;padding:40px;width:400px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}</style></head>
    <body><div class="c"><h1>🔑 Change Password</h1><div id="msg"></div>
    <input type="password" id="cur" placeholder="Current Password">
    <input type="password" id="newp" placeholder="New Password">
    <input type="password" id="conf" placeholder="Confirm New Password">
    <button onclick="submitPass()">Save</button>
    <div class="link"><a href="/">Back</a></div></div>
    <script>async function submitPass(){
        const c=document.getElementById('cur').value,n=document.getElementById('newp').value,co=document.getElementById('conf').value;
        if(n!==co)return document.getElementById('msg').innerHTML='<div class="error">Passwords mismatch</div>';
        const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:c,newpass:n})});
        const d=await r.json();
        if(d.success){alert('✅ Password changed!');window.location.href='/';} 
        else {document.getElementById('msg').innerHTML='<div class="error">'+d.error+'</div>';}
    }</script></body></html>`);
});

app.post('/api/change-password', isAuthenticated, express.json(), (req, res) => {
    const { current, newpass } = req.body;
    const user = users[req.session.userId];
    if (!bcrypt.compareSync(current, user.password)) return res.json({success: false, error: 'Wrong current password'});
    user.password = bcrypt.hashSync(newpass, 10);
    saveUsers();
    res.json({success: true});
});

// ==================== ГЛАВНЫЙ ДАШБОРД (ПОЛНАЯ ВЕРСИЯ) ====================
app.get('/', isAuthenticated, (req, res) => {
    if (!isDataLoaded) return res.send('<h1 style="color:white;text-align:center;padding:50px;">⏳ Loading data... Please refresh in 5 seconds.</h1><script>setTimeout(()=>location.reload(), 5000);</script>');
    
    const currentUser = users[req.session.userId];
    const isSuperAdmin = currentUser?.role === 'superadmin';
    let linksHtml = '';
    const allLinks = Object.entries(subscriptions);
    const visibleLinks = isSuperAdmin ? allLinks : allLinks.filter(([_, s]) => s.owner === req.session.userId);
    
    for (const [id, data] of visibleLinks) {
        const status = data.isDestroyed ? '💀 DESTROYED' : 
                       (isSubscriptionExpired(data) ? '⏰ EXPIRED' : 
                       (isTrafficLimitExceeded(data) ? '📊 TRAFFIC LIMIT' : '✅ ACTIVE'));
        const statusColor = data.isDestroyed || isSubscriptionExpired(data) ? '#d32f2f' : '#238636';
        
        linksHtml += `
            <div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <code style="color:#0f0;font-size:16px;">🔗 /p/${id}</code>
                    <span style="color:${statusColor};font-weight:bold;">${status}</span>
                </div>
                <div style="color:#8b949e;font-size:13px;margin-bottom:10px;">
                    📝 ${data.name || 'No Name'} | 👤 ${data.owner} | 📱 ${Object.keys(data.devices||{}).length}/${data.maxDevices || '∞'} | 
                    ⏰ ${data.expiryDate ? new Date(data.expiryDate).toLocaleDateString() : '∞'} |
                    🌐 ${data.trafficLimit ? ((Object.values(data.devices||{}).reduce((s,d)=>s+(d.trafficUsed||0),0)/data.trafficLimit*100).toFixed(1)+'%') : '∞'}
                </div>
                <div>
                    <button onclick="window.extendSubscription('${id}')" style="background:#238636;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;font-weight:bold;">💰 Продлить</button>
                    <button onclick="window.copyLink('${id}')" style="background:#1f6392;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">📋 Копировать</button>
                    <button onclick="window.showQR('${id}')" style="background:#ff9800;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">📱 QR</button>
                    <button onclick="window.showDevices('${id}')" style="background:#6f42c1;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">👁 Устройства</button>
                    <button onclick="window.editSub('${id}')" style="background:#1f6392;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">✏️ Изм.</button>
                    <button onclick="window.deleteSub('${id}')" style="background:#d32f2f;color:white;border:none;padding:8px 15px;border-radius:6px;cursor:pointer;margin-left:5px;">🗑 Удалить</button>
                </div>
            </div>`;
    }
    
    const adminBtn = isSuperAdmin ? '<a href="/admin/users" style="float:right;margin-right:10px;color:#fff;text-decoration:none;"><button style="background:#8b4513;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;">👥 Users</button></a>' : '';

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>VPN Admin Full</title>
    <style>body{font-family:Arial;padding:20px;background:#0d1117;color:#fff;}
    .card{background:#161b22;padding:20px;border-radius:12px;margin-bottom:20px;}
    button{padding:8px 12px;margin:5px;border-radius:6px;border:none;cursor:pointer;}
    input,textarea,select{padding:10px;width:100%;background:#0d1117;color:#fff;border:1px solid #333;border-radius:6px;margin:5px 0;box-sizing:border-box;}
    .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;}
    .modal-content{background:#161b22;margin:5% auto;padding:20px;width:90%;max-width:500px;border-radius:12px;max-height:80vh;overflow-y:auto;}
    .close{color:#fff;float:right;font-size:24px;cursor:pointer;}
    .dev-item{background:#0d1117;padding:10px;margin:5px 0;border-radius:6px;border-left:3px solid #238636;}</style></head>
    <body>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="margin:0;">👤 ${req.session.userId}</h2>
            <div>${adminBtn}
            <a href="/change-password"><button style="background:#8b4513;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;margin-right:5px;">🔑 Pass</button></a>
            <a href="/export-all"><button style="background:#1f6392;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;margin-right:5px;">💾 Export</button></a>
            <a href="/logout"><button style="background:#d32f2f;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;">🚪 Logout</button></a></div>
        </div>
        
        <div class="card">
            <h1>✨ Создать подписку</h1>
            <form action="/generate" method="POST">
                <input type="text" name="name" placeholder="Название подписки" required>
                <textarea name="content" placeholder="Вставьте конфиг VLESS/Trojan..." rows="3" required></textarea>
                <div style="display:flex;gap:10px;">
                    <input type="number" name="duration" value="30" min="1" style="width:30%;">
                    <select name="unit" style="width:30%;"><option value="days" selected>Дней</option><option value="hours">Часов</option><option value="months">Месяцев</option></select>
                </div>
                <div style="display:flex;gap:10px;">
                    <input type="number" name="maxDevices" value="0" min="0" placeholder="Max Devices (0=∞)" style="width:48%;">
                    <input type="number" name="trafficLimit" value="0" min="0" placeholder="Traffic MB (0=∞)" style="width:48%;">
                </div>
                <button type="submit" style="background:#238636;color:white;padding:12px;width:100%;font-weight:bold;margin-top:10px;">✨ Создать</button>
            </form>
        </div>
        
        <div class="card">
            <h2>📋 Мои подписки</h2>
            ${linksHtml || '<p style="color:#8b949e;">Нет подписок.</p>'}
        </div>
        
        <!-- МОДАЛЬНОЕ ОКНО -->
        <div id="mainModal" class="modal"><div class="modal-content"><span class="close" onclick="document.getElementById('mainModal').style.display='none'">&times;</span><div id="modalBody"></div></div></div>
        
        <script>
            window.copyLink = function(id) {
                const url = window.location.origin + '/p/' + id;
                navigator.clipboard.writeText(url).then(() => alert('✅ Copied!'));
            };
            
            window.deleteSub = function(id) {
                if(confirm('Delete ' + id + '?')) fetch('/delete/' + id, { method: 'POST' }).then(() => location.reload());
            };

            window.showQR = function(id) {
                window.open('/generate-qrcode/' + id, '_blank', 'width=400,height=500');
            };

            window.editSub = function(id) {
                const newConf = prompt('Enter new config:');
                if(newConf) fetch('/edit/' + id, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: newConf}) }).then(() => location.reload());
            };

            window.showDevices = function(id) {
                fetch('/devices/' + id).then(r => r.json()).then(devs => {
                    let html = '<h3>📱 Devices for ' + id + '</h3>';
                    for(const [uuid, d] of Object.entries(devs)) {
                        html += '<div class="dev-item" style="border-color:' + (d.active ? '#238636' : '#d32f2f') + '">';
                        html += '<b>' + (d.name||'Unknown') + '</b><br>';
                        html += 'IP: ' + d.ip + '<br>';
                        html += 'Country: ' + (d.country||'Unknown') + '<br>';
                        html += 'Traffic: ' + ((d.trafficUsed||0)/1024/1024).toFixed(2) + ' MB<br>';
                        html += 'Status: ' + (d.active ? 'Active' : 'Inactive');
                        if(!d.active) html += ' <button onclick="restoreDev(\''+id+'\',\''+uuid+'\')" style="background:#238636;color:white;border:none;padding:2px 5px;border-radius:3px;">Restore</button>';
                        else html += ' <button onclick="killDev(\''+id+'\',\''+uuid+'\')" style="background:#d32f2f;color:white;border:none;padding:2px 5px;border-radius:3px;">Kill</button>';
                        html += '</div>';
                    }
                    document.getElementById('modalBody').innerHTML = html;
                    document.getElementById('mainModal').style.display = 'block';
                });
            };

            window.killDev = function(id, uuid) {
                fetch('/deactivate-device/' + id + '/' + uuid, {method:'POST'}).then(() => window.showDevices(id));
            };
            window.restoreDev = function(id, uuid) {
                fetch('/restore-device/' + id + '/' + uuid, {method:'POST'}).then(() => window.showDevices(id));
            };

            window.extendSubscription = function(id) {
                const html = '<h3>💰 Продлить ' + id + '</h3>' +
                    '<p>Duration:</p><select id="extUnit"><option value="days" selected>Days</option><option value="hours">Hours</option><option value="months">Months</option></select>' +
                    '<input type="number" id="extValue" value="30" min="1">' +
                    '<p>Max Devices (0=∞):</p><input type="number" id="extDevices" value="0" min="0">' +
                    '<p>Traffic MB (0=∞):</p><input type="number" id="extTraffic" value="0" min="0">' +
                    '<button id="btnSubmit" style="background:#238636;color:white;width:100%;padding:12px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;margin-top:15px;">✅ Продлить</button>';
                
                document.getElementById('modalBody').innerHTML = html;
                document.getElementById('mainModal').style.display = 'block';
                
                document.getElementById('btnSubmit').onclick = function() {
                    window.submitExtension(id);
                };
            };

            window.submitExtension = function(id) {
                const btn = document.getElementById('btnSubmit');
                btn.innerHTML = '⏳ Processing...';
                btn.disabled = true;
                
                fetch('/api/extend/' + id, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        duration: parseInt(document.getElementById('extValue').value),
                        unit: document.getElementById('extUnit').value,
                        maxDevices: parseInt(document.getElementById('extDevices').value),
                        trafficLimit: parseInt(document.getElementById('extTraffic').value)
                    })
                })
                .then(r => r.json())
                .then(res => {
                    if(res.success) { alert('✅ Extended!'); location.reload(); } 
                    else { alert('❌ Error'); btn.disabled = false; btn.innerHTML = '✅ Extend'; }
                })
                .catch(e => { alert('❌ Network Error'); btn.disabled = false; btn.innerHTML = '✅ Extend'; });
            };
        </script>
    </body></html>`);
});

// ==================== API И МАРШРУТЫ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    if (!isDataLoaded) return res.status(503).send('Loading...');
    const id = generateRandomId();
    const duration = parseInt(req.body.duration) || 30;
    const unit = req.body.unit || 'days';
    const trafficLimit = parseInt(req.body.trafficLimit) || 0;
    const maxDevices = parseInt(req.body.maxDevices) || 0;
    
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content), content: addPrefix(req.body.content),
        originalContent: null, count: 0, devices: {},
        owner: req.session.userId, name: req.body.name || `Sub #${id}`,
        trafficLimit: trafficLimit > 0 ? trafficLimit * 1024 * 1024 : 0,
        maxDevices: maxDevices,
        expiryDate: calculateExpiryDate(duration, unit).toISOString(),
        isDestroyed: false, createdAt: new Date().toISOString()
    };
    if (users[req.session.userId]) { users[req.session.userId].linksCreated++; saveUsers(); }
    saveToGist();
    res.redirect('/');
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id]) { delete subscriptions[req.params.id]; saveToGist(); }
    res.redirect('/');
});

app.post('/edit/:id', isAuthenticated, express.json(), (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        updateAllDevicesConfig(id); // 🔥 Обновляем для всех устройств
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id]) res.json(subscriptions[req.params.id].devices || {});
    else res.status(404).json({error: 'Not found'});
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId]?.devices?.[deviceId]) {
        subscriptions[linkId].devices[deviceId].active = false;
        subscriptions[linkId].devices[deviceId].config = DESTROY_CONFIG;
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.post('/restore-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId]?.devices?.[deviceId]) {
        subscriptions[linkId].devices[deviceId].active = true;
        subscriptions[linkId].devices[deviceId].config = subscriptions[linkId].masterConfig;
        saveToGist();
        res.json({success: true});
    } else res.status(404).json({error: 'Not found'});
});

app.post('/api/extend/:id', isAuthenticated, express.json(), (req, res) => {
    if (!isDataLoaded) return res.status(503).json({error: 'Loading'});
    const { id } = req.params;
    const { duration, unit, maxDevices, trafficLimit } = req.body;
    const sub = subscriptions[id];
    
    if (sub && (sub.owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        sub.expiryDate = calculateExpiryDate(duration, unit).toISOString();
        if (maxDevices !== undefined) sub.maxDevices = parseInt(maxDevices);
        if (trafficLimit !== undefined) sub.trafficLimit = parseInt(trafficLimit) > 0 ? parseInt(trafficLimit) * 1024 * 1024 : 0;
        
        // 🔥 Восстановление если подписка была уничтожена
        if (sub.isDestroyed && sub.originalContent) {
            sub.masterConfig = sub.originalContent;
            sub.content = sub.originalContent;
            sub.isDestroyed = false;
            sub.originalContent = null;
            if (sub.devices) {
                for (const devId in sub.devices) {
                    sub.devices[devId].active = true;
                    sub.devices[devId].config = sub.masterConfig;
                }
            }
        }
        saveToGist();
        res.json({success: true});
    } else {
        res.status(404).json({error: 'Not found'});
    }
});

app.get('/generate-qrcode/:id', isAuthenticated, async (req, res) => {
    if (subscriptions[req.params.id]) {
        const newDeviceId = uuidv4();
        const url = `${req.protocol}://${req.get('host')}/p/${req.params.id}?deviceId=${newDeviceId}`;
        try {
            const qrCode = await QRCode.toDataURL(url);
            res.send(`<h2 style="text-align:center">QR Code</h2><div style="text-align:center"><img src="${qrCode}" style="background:white;padding:10px;border-radius:8px;"></div><p style="text-align:center;font-size:12px">UUID: ${newDeviceId}</p>`);
        } catch (e) { res.status(500).send('Error'); }
    } else res.status(404).send('Not found');
});

app.get('/admin/users', isAuthenticated, isAdmin, (req, res) => {
    let usersHtml = '';
    for (const [username, user] of Object.entries(users)) {
        const linksCount = Object.values(subscriptions).filter(s => s.owner === username).length;
        usersHtml += `<div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
            <strong>👤 ${username}</strong> (${user.role})<br>Links: ${linksCount} | Blocked: ${user.blocked}
            <div style="margin-top:5px;">
                ${user.blocked ? `<button onclick="unblock('${username}')" style="background:#238636;color:white;border:none;padding:5px;">Unblock</button>` : `<button onclick="block('${username}')" style="background:#d32f2f;color:white;border:none;padding:5px;">Block</button>`}
                <button onclick="delUser('${username}')" style="background:#d32f2f;color:white;border:none;padding:5px;">Delete</button>
            </div></div>`;
    }
    res.send(`<!DOCTYPE html><html><body style="background:#0d1117;color:white;padding:20px;">
    <h1>👥 User Management</h1><a href="/"><button style="background:#6e7681;color:white;border:none;padding:10px;">Back</button></a>
    ${usersHtml}
    <script>
        function block(u){fetch('/api/block-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}
        function unblock(u){fetch('/api/unblock-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}
        function delUser(u){if(confirm('Delete '+u+'?')){fetch('/api/delete-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(()=>location.reload());}}
    </script></body></html>`);
});

app.post('/api/block-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]) { users[req.body.username].blocked=true; saveUsers(); } res.json({success:true}); });
app.post('/api/unblock-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]) { users[req.body.username].blocked=false; saveUsers(); } res.json({success:true}); });
app.post('/api/delete-user', isAuthenticated, isAdmin, express.json(), (req, res) => {
    const { username } = req.body;
    if (username && username !== req.session.userId && users[username]) {
        for (const [id, sub] of Object.entries(subscriptions)) { if (sub.owner === username) delete subscriptions[id]; }
        delete users[username]; saveUsers(); saveToGist();
    } res.json({success:true}); 
});

app.get('/export-all', isAuthenticated, (req, res) => {
    const data = JSON.stringify({ version: '1.8', subscriptions }, null, 2);
    const b64 = Buffer.from(data).toString('base64');
    res.setHeader('Content-Disposition', 'attachment; filename=backup.txt');
    res.send(`VPN BACKUP\n[ДАННЫЕ В BASE64]\n${b64}`);
});

// ==================== ПОТРЕБИТЕЛЬСКАЯ ССЫЛКА (/p/:id) ====================
app.get('/p/:id', async (req, res) => {
    if (!isDataLoaded) return res.status(503).send('# Server initializing...');
    const id = req.params.id;
    if (!subscriptions[id]) return res.status(404).send('Not found');
    
    const sub = subscriptions[id];
    let deviceId = req.query.deviceId;
    if (!deviceId) { deviceId = uuidv4(); return res.redirect(`/p/${id}?deviceId=${deviceId}`); }
    
    sub.count = (sub.count || 0) + 1;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || '0.0.0.0';
    const country = await getCountryFromIP(ip);
    
    if (!sub.devices) sub.devices = {};
    
    if (!sub.devices[deviceId]) {
        if (isDeviceLimitExceeded(sub)) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(DESTROY_CONFIG); 
        }
        sub.devices[deviceId] = {
            name: country, country, ip,
            userAgent: req.headers['user-agent'],
            firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
            active: true, config: sub.masterConfig || sub.content, trafficUsed: 0
        };
    } else {
        const device = sub.devices[deviceId];
        device.lastSeen = new Date().toISOString();
        device.ip = ip;
        if (device.country !== country) device.country = country;
        // 🔥 Обновляем конфиг для устройства, если мастер-конфиг изменился
        if (device.active && !sub.isDestroyed && device.config !== sub.masterConfig) device.config = sub.masterConfig;
        device.trafficUsed = (device.trafficUsed || 0) + Buffer.byteLength(device.config, 'utf8');
    }
    
    if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
        if (!sub.originalContent) sub.originalContent = sub.masterConfig;
        applyDestroyConfig(sub);
    }
    
    saveToGist();
    
    const device = sub.devices[deviceId];
    const configToSend = (device?.active && !sub.isDestroyed) ? device.config : DESTROY_CONFIG;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(configToSend);
});

// ==================== ЗАПУСК ====================
loadUsers();

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await loadFromGist();
    checkSubscriptions();
});
