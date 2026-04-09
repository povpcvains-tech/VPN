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
// Для Render/Heroku/VPS используйте переменные окружения
const GIST_ID = process.env.GIST_ID || 'fe2b9abda4ee7cf16314d8422c97f933';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';

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
                    linksCreated: 0,
                    hasPremium: true // Админу доступны все функции
                },
                'base64': {
                    username: 'base64',
                    password: hashedBase64,
                    createdAt: new Date().toISOString(),
                    role: 'superadmin',
                    blocked: false,
                    frozen: false,
                    linksCreated: 0,
                    hasPremium: true
                }
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
        
        // Миграция полей
        let migrated = false;
        for (const username in users) {
            if (!users[username].role) { users[username].role = 'user'; migrated = true; }
            if (users[username].blocked === undefined) { 
                users[username].blocked = false; 
                users[username].frozen = false; 
                users[username].linksCreated = 0; 
                users[username].hasPremium = false;
                migrated = true; 
            }
        }
        if (migrated) saveUsers();
        
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

function saveUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } 
    catch (error) { console.error('Ошибка сохранения пользователей:', error); }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function generateRandomId() {
    return Math.random().toString(36).substring(2, 8);
}

function addPrefix(content) {
    if (!content.startsWith(PROFILE_PREFIX)) return PROFILE_PREFIX + content;
    return content;
}

function removePrefix(content) {
    if (content.startsWith(PROFILE_PREFIX)) return content.substring(PROFILE_PREFIX.length);
    return content;
}

function replaceAddressInConfig(config, newAddress) {
    return config.replace(/@[\d\.]+:\d+/, `@${newAddress}`);
}

async function getCountryFromIP(ip) {
    try {
        // Используем ip-api.com (бесплатно до 45 запросов в минуту)
        const response = await axios.get(`http://ip-api.com/json/${ip}`);
        if (response.data.status === 'success') return response.data.country;
    } catch (error) { console.error('Ошибка IP:', error.message); }
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

function isSubscriptionExpired(sub) {
    if (!sub.expiryDate) return false;
    return new Date() > new Date(sub.expiryDate);
}

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

function isDeviceLimitExceeded(sub) {
    if (!sub.maxDevices || sub.maxDevices <= 0) return false;
    const activeDevices = sub.devices ? Object.keys(sub.devices).length : 0;
    return activeDevices >= sub.maxDevices;
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

function updateAllDevicesConfig(subId) {
    const sub = subscriptions[subId];
    if (!sub || !sub.devices) return;
    for (const deviceId in sub.devices) {
        if (sub.devices[deviceId].active && !sub.isDestroyed) {
            sub.devices[deviceId].config = sub.masterConfig;
        }
    }
}

// Проверка подписок каждые 5 минут
function checkSubscriptions() {
    for (const [id, sub] of Object.entries(subscriptions)) {
        if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
            console.log(`🔥 Подписка ${id} истекла/лимит превышен -> Destroy`);
            // Сохраняем оригинал перед уничтожением, если еще не сохранен
            if (!sub.originalContent) sub.originalContent = sub.masterConfig;
            applyDestroyConfig(sub);
        }
    }
    saveToGist();
}
setInterval(checkSubscriptions, 5 * 60 * 1000);

// ==================== РАБОТА С GIST ====================
async function saveToGist() {
    console.log('💾 Saving to Gist...');
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: { 'DataBAse.json': { content: JSON.stringify(subscriptions, null, 2) } }
            })
        });
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        console.log('✅ Saved to Gist');
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
                    if (!data.maxDevices) data.maxDevices = 0; // 0 = безлимит
                    if (!data.owner) data.owner = 'admin';
                }
                console.log(`✅ Loaded ${Object.keys(subscriptions).length} subs`);
                return true;
            }
        }
        throw new Error('Failed to load');
    } catch (error) {
        console.error('❌ Gist Load Error:', error.message);
        if (fs.existsSync(BACKUP_FILE)) {
            subscriptions = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
            console.log('📁 Loaded from local backup');
            return true;
        }
        return false;
    }
}

// ==================== MIDDLEWARE ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'vpn-secret-key-v1.7',
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
    if (users[req.session.userId]?.role === 'admin' || users[req.session.userId]?.role === 'superadmin') next();
    else res.status(403).send('Access Denied');
}

// ==================== СТРАНИЦЫ АВТОРИЗАЦИИ ====================
app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Register</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .container{background:white;border-radius:16px;padding:40px;width:450px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}
    button:hover{background:#5a67d8;}.link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}
    .error{background:#f8d7da;border:1px solid #f5c6cb;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}</style></head>
    <body><div class="container"><h1>📝 Register</h1>
    ${req.query.error ? '<div class="error">❌ '+req.query.error+'</div>' : ''}
    <form action="/register" method="POST"><input type="text" name="username" placeholder="Login" required minlength="3">
    <input type="password" name="password" placeholder="Password" required minlength="6">
    <input type="password" name="confirm_password" placeholder="Confirm Password" required>
    <button type="submit">Sign Up</button></form>
    <div class="link"><a href="/login">← Login</a></div></div></body></html>`);
});

app.post('/register', (req, res) => {
    const { username, password, confirm_password } = req.body;
    if (password !== confirm_password) return res.redirect('/register?error=Passwords mismatch');
    if (users[username]) return res.redirect('/register?error=User exists');
    
    users[username] = {
        username, password: bcrypt.hashSync(password, 10),
        createdAt: new Date().toISOString(), role: 'user',
        blocked: false, frozen: false, linksCreated: 0, hasPremium: false
    };
    saveUsers();
    res.redirect('/login?registered=true');
});

app.get('/login', (req, res) => {
    const error = req.query.error === 'auth' ? '❌ Wrong login/password' : 
                  req.query.error === 'blocked' ? '🚫 Account blocked' : '';
    const registered = req.query.registered === 'true' ? '✅ Registered! Login now.' : '';
    
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title>
    <style>body{font-family:Arial;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;margin:0;}
    .container{background:white;border-radius:16px;padding:40px;width:450px;max-width:90%;}
    h1{text-align:center;color:#333;}input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}button:hover{background:#5a67d8;}
    .warning{padding:12px;border-radius:8px;margin:15px 0;font-size:13px;}.error{background:#f8d7da;color:#721c24;}.success{background:#d4edda;color:#155724;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}</style></head>
    <body><div class="container"><h1>🔐 VPN Admin</h1>
    ${error ? `<div class="warning error">${error}</div>` : ''}
    ${registered ? `<div class="warning success">${registered}</div>` : ''}
    <form action="/login" method="POST"><input type="text" name="username" placeholder="Login" required>
    <input type="password" name="password" placeholder="Password" required>
    <button type="submit">Login</button></form>
    <div class="link"><a href="/register">📝 Register</a></div></div></body></html>`);
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
    .container{background:white;border-radius:16px;padding:40px;width:450px;max-width:90%;}
    input,button{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ddd;font-size:14px;box-sizing:border-box;}
    button{background:#667eea;color:white;border:none;cursor:pointer;font-weight:bold;}button:hover{background:#5a67d8;}
    .link{text-align:center;margin-top:15px;}.link a{color:#667eea;text-decoration:none;}
    .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:8px;margin-bottom:15px;}
    .success{background:#d4edda;color:#155724;padding:10px;border-radius:8px;margin-bottom:15px;}</style></head>
    <body><div class="container"><h1>🔐 Change Password</h1><div id="message"></div>
    <form id="changeForm" onsubmit="event.preventDefault(); changePassword();">
    <input type="password" id="current" placeholder="Current Password" required>
    <input type="password" id="newpass" placeholder="New Password" required minlength="6">
    <input type="password" id="confirm" placeholder="Confirm New Password" required>
    <button type="submit">💾 Save</button></form>
    <div class="link"><a href="/">← Back</a></div></div>
    <script>async function changePassword(){
        const current=document.getElementById('current').value;
        const newpass=document.getElementById('newpass').value;
        const confirm=document.getElementById('confirm').value;
        const msg=document.getElementById('message');
        if(newpass!==confirm){msg.innerHTML='<div class="error">❌ Passwords mismatch</div>';return;}
        try{
            const res=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current,newpass})});
            const data=await res.json();
            if(data.success){msg.innerHTML='<div class="success">✅ Changed! Redirecting...</div>';setTimeout(()=>window.location.href='/',2000);}
            else{msg.innerHTML='<div class="error">❌ '+data.error+'</div>';}
        }catch(e){msg.innerHTML='<div class="error">❌ Network Error</div>';}
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

// ==================== ВОССТАНОВЛЕНИЕ И ЭКСПОРТ ====================
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
            console.log(`✅ Restored ${Object.keys(subscriptions).length} subs`);
        } else { return res.redirect('/login?error=invalid'); }
    } catch (e) { return res.redirect('/login?error=invalid'); }
    res.redirect('/login');
});

app.post('/restore-from-gist', async (req, res) => { await loadFromGist(); res.redirect('/login'); });

app.get('/export-all', isAuthenticated, (req, res) => {
    const exportData = { version: '1.7', exportDate: new Date().toISOString(), totalLinks: Object.keys(subscriptions).length, subscriptions };
    const jsonString = JSON.stringify(exportData, null, 2);
    const base64Data = Buffer.from(jsonString).toString('base64');
    const fileContent = `VPN SUBSCRIPTIONS BACKUP v1.7\n========================\n[ДАННЫЕ В BASE64]\n${base64Data}\n========================`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=vpn-backup-${Date.now()}.txt`);
    res.send(fileContent);
});

// ==================== ГЕНЕРАЦИЯ QR ====================
app.get('/generate-qrcode/:id', isAuthenticated, async (req, res) => {
    const id = req.params.id;
    if (subscriptions[id]) {
        const newDeviceId = uuidv4();
        const url = `${req.protocol}://${req.get('host')}/p/${id}?deviceId=${newDeviceId}`;
        try {
            const qrCode = await QRCode.toDataURL(url);
            res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR Code</title>
            <style>body{font-family:Arial;background:#0d1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
            .container{background:#161b22;padding:30px;border-radius:12px;text-align:center;}img{background:white;padding:10px;border-radius:8px;}
            button{margin-top:20px;padding:10px 20px;background:#238636;color:white;border:none;border-radius:6px;cursor:pointer;}button:hover{background:#2ea043;}</style></head>
            <body><div class="container"><h2>🔗 QR Code</h2><img src="${qrCode}" alt="QR"><br><button onclick="window.close()">Close</button></div></body></html>`);
        } catch (error) { res.status(500).send('Error'); }
    } else { res.status(404).send('Not found'); }
});

// ==================== АДМИН ПАНЕЛЬ ПОЛЬЗОВАТЕЛЕЙ ====================
app.get('/admin/users', isAuthenticated, isAdmin, (req, res) => {
    let usersHtml = '';
    for (const [username, user] of Object.entries(users)) {
        const linksCount = Object.values(subscriptions).filter(s => s.owner === username).length;
        usersHtml += `<div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
            <div style="margin-bottom:8px;"><strong>👤 ${escapeHtml(username)}</strong> 
            ${user.role==='superadmin'?'<span style="color:gold;">⭐ SUPERADMIN</span>':''}
            ${user.role==='admin'?'<span style="color:#58a6ff;">🔷 ADMIN</span>':''}
            ${user.blocked?'<span style="color:red;">🚫 Blocked</span>':''}
            ${user.frozen?'<span style="color:orange;">❄️ Frozen</span>':''}</div>
            <div style="font-size:13px;color:#8b949e;margin-bottom:10px;">📧 Created: ${new Date(user.createdAt).toLocaleDateString()}<br>🔗 Links: ${linksCount}</div>
            <div>
                <button onclick="viewUserContent('${username}')" style="background:#1f6392;">👁 Content</button>
                <button onclick="warnUser('${username}')" style="background:#d29922;">⚠ Warn</button>
                ${user.blocked ? `<button onclick="unblockUser('${username}')" style="background:#238636;">✅ Unblock</button>` : `<button onclick="blockUser('${username}')" style="background:#8b0000;">🔒 Block</button>`}
                ${user.frozen ? `<button onclick="unfreezeUser('${username}')" style="background:#238636;">🔓 Unfreeze</button>` : `<button onclick="freezeUser('${username}')" style="background:#8b4513;">❄️ Freeze</button>`}
                <button onclick="deleteUser('${username}')" style="background:#d32f2f;">🗑 Delete</button>
            </div></div>`;
    }
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>User Management</title>
    <style>body{font-family:Arial;padding:20px;background:#0d1117;color:#fff;}.card{background:#161b22;padding:20px;border-radius:12px;margin-bottom:20px;}
    button{padding:8px 12px;margin:5px;border-radius:6px;border:none;cursor:pointer;}.back{background:#6e7681;color:white;}
    .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;}
    .modal-content{background:#161b22;margin:50px auto;padding:20px;width:80%;max-width:500px;border-radius:12px;}.close{color:#fff;float:right;font-size:28px;cursor:pointer;}</style></head>
    <body><div style="overflow:hidden;margin-bottom:20px;"><span style="font-size:18px;">👮 Admin Panel</span>
    <a href="/"><button class="back" style="float:right;">← Back</button></a></div>
    <div class="card"><h2>👥 Users: ${Object.keys(users).length}</h2>${usersHtml}</div>
    <div id="modal" class="modal"><div class="modal-content"><span class="close" onclick="closeModal()">&times;</span><div id="modalContent"></div></div></div>
    <script>function closeModal(){document.getElementById('modal').style.display='none';}
    function viewUserContent(username){fetch('/api/user-content/'+username).then(r=>r.json()).then(data=>{
        let html='<h3>📦 User: '+username+'</h3>';if(data.links.length===0)html+='<p>No links</p>';
        else{for(const[id,sub]of Object.entries(data.links)){html+='<div style="background:#0d1117;padding:10px;margin:5px 0;border-radius:6px;"><strong>'+escapeHtml(sub.name||id)+'</strong></div>';}}
        document.getElementById('modalContent').innerHTML=html;document.getElementById('modal').style.display='block';});}
    function warnUser(username){const reason=prompt('Warn message for '+username+':');if(reason){fetch('/api/warn-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,reason})}).then(()=>location.reload());}}
    function blockUser(username){const time=prompt('Block duration (hours/days/forever):','forever');const reason=prompt('Reason:');if(time&&reason){fetch('/api/block-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,time,reason})}).then(()=>location.reload());}}
    function unblockUser(username){if(confirm('Unblock '+username+'?')){fetch('/api/unblock-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}).then(()=>location.reload());}}
    function freezeUser(username){const time=prompt('Freeze duration:','24 hours');const reason=prompt('Reason:');if(time&&reason){fetch('/api/freeze-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,time,reason})}).then(()=>location.reload());}}
    function unfreezeUser(username){if(confirm('Unfreeze '+username+'?')){fetch('/api/unfreeze-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}).then(()=>location.reload());}}
    function deleteUser(username){if(confirm('⚠️ DELETE '+username+' forever?')){fetch('/api/delete-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}).then(()=>location.reload());}}
    function escapeHtml(text){if(!text)return'';return text.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}</script></body></html>`);
});

// API управления пользователями
app.post('/api/warn-user', isAuthenticated, isAdmin, express.json(), (req, res) => { console.log(`⚠️ Warn ${req.body.username}: ${req.body.reason}`); res.json({success:true}); });
app.post('/api/block-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username] && req.body.username!==req.session.userId){users[req.body.username].blocked=true;saveUsers();}res.json({success:true}); });
app.post('/api/unblock-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]){users[req.body.username].blocked=false;saveUsers();}res.json({success:true}); });
app.post('/api/freeze-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username] && req.body.username!==req.session.userId){users[req.body.username].frozen=true;saveUsers();}res.json({success:true}); });
app.post('/api/unfreeze-user', isAuthenticated, isAdmin, express.json(), (req, res) => { if(users[req.body.username]){users[req.body.username].frozen=false;saveUsers();}res.json({success:true}); });
app.post('/api/delete-user', isAuthenticated, isAdmin, express.json(), (req, res) => { 
    const { username } = req.body;
    if (username && username !== req.session.userId && users[username]) {
        for (const [id, sub] of Object.entries(subscriptions)) { if (sub.owner === username) delete subscriptions[id]; }
        delete users[username]; saveUsers(); saveToGist();
    } res.json({success:true}); 
});
app.get('/api/user-content/:username', isAuthenticated, isAdmin, (req, res) => {
    const userLinks = {};
    for (const [id, sub] of Object.entries(subscriptions)) { if (sub.owner === req.params.username) userLinks[id] = { name: sub.name }; }
    res.json({ username: req.params.username, links: userLinks });
});

// ==================== ГЛАВНЫЙ ДАШБОРД ====================
app.get('/', isAuthenticated, (req, res) => {
    const currentUser = users[req.session.userId];
    const isSuperAdmin = currentUser?.role === 'superadmin';
    
    let linksHtml = '';
    const allLinks = Object.entries(subscriptions);
    // Фильтрация: админ видит всё, юзер только своё
    const visibleLinks = isSuperAdmin ? allLinks : allLinks.filter(([_, s]) => s.owner === req.session.userId);
    
    for (const [id, data] of visibleLinks) {
        const shortContent = removePrefix(data.masterConfig || data.content || '').substring(0, 50);
        const displayContent = shortContent + (removePrefix(data.masterConfig || data.content || '').length > 50 ? '...' : '');
        const devicesCount = data.devices ? Object.keys(data.devices).length : 0;
        
        // Статус
        let statusBadge = '';
        if (data.isDestroyed) statusBadge = '<span style="color:#d32f2f;font-weight:bold;">💀 DESTROYED</span>';
        else if (isSubscriptionExpired(data)) statusBadge = '<span style="color:#d32f2f;">⏰ EXPIRED</span>';
        else if (isTrafficLimitExceeded(data)) statusBadge = '<span style="color:#d32f2f;">📊 TRAFFIC LIMIT</span>';
        else if (data.expiryDate) {
            const daysLeft = Math.ceil((new Date(data.expiryDate) - new Date()) / (1000*60*60*24));
            statusBadge = `<span style="color:#238636;">⏳ ${daysLeft} days left</span>`;
        }
        
        // Лимит устройств
        const deviceLimitText = data.maxDevices > 0 ? `${devicesCount}/${data.maxDevices}` : `${devicesCount}/∞`;
        const isDeviceLimitReached = data.maxDevices > 0 && devicesCount >= data.maxDevices;
        
        linksHtml += `
            <div style="margin:10px 0;padding:15px;border:1px solid #333;background:#1e1e1e;border-radius:8px;">
                <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
                    <div><code style="color:#0f0;font-size:16px;">🔗 /p/${id}</code>
                    <span style="margin-left:10px;color:#8b949e;font-size:13px;">${escapeHtml(data.name || 'No Name')}</span></div>
                    ${statusBadge}
                </div>
                <div style="margin-bottom:8px;color:#58a6ff;">📝 ${escapeHtml(displayContent)}</div>
                <div style="margin-bottom:12px;font-size:13px;">
                    👥 ${data.count || 0} hits | 
                    📱 Devices: <span style="${isDeviceLimitReached?'color:red;font-weight:bold;':''}">${deviceLimitText}</span> | 
                    🌐 Traffic: ${data.trafficLimit ? (Object.values(data.devices||{}).reduce((s,d)=>s+(d.trafficUsed||0),0)/data.trafficLimit*100).toFixed(1)+'%' : '∞'}
                    ${data.expiryDate ? ' | ⏰ Exp: '+new Date(data.expiryDate).toLocaleDateString() : ''}
                </div>
                <div>
                    <button onclick="copyWithNewDevice('${id}')" style="background:#1f6392;">📋 Copy (New Dev)</button>
                    <button onclick="window.open('/generate-qrcode/${id}','_blank','width=400,height=500')" style="background:#ff9800;">📱 QR</button>
                    
                    <!-- Кнопка Изменить скрыта, если уничтожено -->
                    ${!data.isDestroyed ? `<button onclick="editLink('${id}')" style="background:#1f6392;">✏️ Edit</button>` : ''}
                    
                    <button onclick="showDevices('${id}')" style="background:#6f42c1;">📱 Devices</button>
                    
                    <!-- Кнопка Продлить видна ВСЕГДА, даже если уничтожено (для восстановления) -->
                    <button onclick="extendSubscription('${id}')" style="background:#238636;">💰 Extend/Renew</button>
                    
                    ${data.originalContent ? `<form action="/restore/${id}" method="POST" style="display:inline;" onsubmit="event.preventDefault();this.submit();"><button type="submit" style="background:#238636;">🔄 Restore Config</button></form>` : ''}
                    <form action="/delete/${id}" method="POST" style="display:inline;" onsubmit="event.preventDefault();if(confirm('Delete forever?'))this.submit();"><button type="submit" style="background:#d32f2f;">🗑 Delete</button></form>
                </div>
            </div>
        `;
    }
    
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>VPN Admin v1.7</title>
    <style>body{font-family:Arial;padding:20px;background:#0d1117;color:#fff;}
    .card{background:#161b22;padding:20px;border-radius:12px;margin-bottom:20px;}
    button{padding:8px 12px;margin:5px;border-radius:6px;border:none;cursor:pointer;}
    input,textarea,select{padding:10px;width:100%;background:#0d1117;color:#fff;border:1px solid #333;border-radius:6px;margin:5px 0;}
    .generate{background:#238636;color:white;}.export{background:#1f6392;color:white;}.logout{background:#d32f2f;float:right;}
    .admin-link{background:#8b4513;color:white;float:right;margin-right:10px;}
    .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;}
    .modal-content{background:#161b22;margin:50px auto;padding:20px;width:80%;max-width:600px;border-radius:12px;max-height:80vh;overflow-y:auto;}
    .close{color:#fff;float:right;font-size:28px;cursor:pointer;}
    .device-item{padding:10px;margin:5px 0;background:#0d1117;border-radius:6px;}.device-active{border-left:4px solid #238636;}.device-inactive{border-left:4px solid #d32f2f;opacity:0.7;}</style>
    <script>
        function copyWithNewDevice(id){
            const newDeviceId=crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16);});
            const url=window.location.origin+'/p/'+id+'?deviceId='+newDeviceId;
            navigator.clipboard.writeText(url);alert('✅ Copied!\\nUUID: '+newDeviceId);
        }
        function editLink(id){
            const newContent=prompt('Enter new config:', '');
            if(newContent){fetch('/edit/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:newContent})}).then(()=>location.reload());}
        }
        function extendSubscription(id){
            const html=\`<h3>💰 Extend Subscription</h3>
            <p>Duration:</p>
            <select id="extUnit"><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days" selected>Days</option><option value="months">Months</option></select>
            <input type="number" id="extValue" value="30" min="1" placeholder="Amount">
            <p>Max Devices (0 = Unlimited):</p>
            <input type="number" id="extDevices" value="0" min="0" placeholder="0">
            <p>Traffic Limit MB (0 = Unlimited):</p>
            <input type="number" id="extTraffic" value="0" min="0" placeholder="0">
            <button onclick="submitExtension('\${id})" style="margin-top:10px;background:#238636;">✅ Extend & Renew</button>\`;
            showModal(html);
        }
        function submitExtension(id){
            const unit=document.getElementById('extUnit').value;
            const value=parseInt(document.getElementById('extValue').value);
            const maxDevices=parseInt(document.getElementById('extDevices').value);
            const trafficLimit=parseInt(document.getElementById('extTraffic').value);
            if(value>0){
                fetch('/api/extend/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({duration:value,unit,maxDevices,trafficLimit})}).then(()=>{closeModal();location.reload();});
            }
        }
        function showDevices(id){
            fetch('/devices/'+id).then(r=>r.json()).then(devices=>{
                let html='<h2>📱 Devices</h2>';
                if(Object.keys(devices).length===0)html+='<p>No devices</p>';
                else{for(const[uuid,device]of Object.entries(devices)){
                    html+=\`<div class="device-item \${device.active?'device-active':'device-inactive'}">
                    <strong>\${escapeHtml(device.name)}</strong><br>IP: \${escapeHtml(device.ip)}<br>
                    📊 Traffic: \${(device.trafficUsed/1024/1024).toFixed(2)} MB<br>
                    Status: \${device.active?'✅ Active':'❌ Inactive'}<br>
                    \${device.active?\<button onclick="deactivateDevice('\${id}','\${uuid}')" style="background:#d32f2f;margin-top:5px;">➖ Deactivate</button>\`:\<button onclick="restoreDevice('\${id}','\${uuid}')" style="background:#238636;margin-top:5px;">🔄 Restore</button>\`}
                    </div>\`;
                }}
                html+='<br><button onclick="closeModal()">Close</button>';showModal(html);
            });
        }
        function deactivateDevice(linkId,deviceId){if(confirm('Deactivate?')){fetch('/deactivate-device/'+linkId+'/'+deviceId,{method:'POST'}).then(()=>showDevices(linkId));}}
        function restoreDevice(linkId,deviceId){if(confirm('Restore?')){fetch('/restore-device/'+linkId+'/'+deviceId,{method:'POST'}).then(()=>showDevices(linkId));}}
        function showModal(content){document.getElementById('modalContent').innerHTML=content;document.getElementById('modal').style.display='block';}
        function closeModal(){document.getElementById('modal').style.display='none';}
        function escapeHtml(text){if(!text)return'';return text.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
    </script></head>
    <body>
        <div style="overflow:hidden;margin-bottom:20px;">
            <span style="font-size:18px;">👤 ${req.session.userId} ${isSuperAdmin?'⭐':''}</span>
            <a href="/change-password"><button style="background:#8b4513;float:right;margin-right:10px;">🔑 Pass</button></a>
            ${isSuperAdmin?\<a href="/admin/users"><button class="admin-link">👥 Users</button></a>\`:''}
            <a href="/logout"><button class="logout">🚪 Logout</button></a>
            <a href="/export-all"><button class="export">💾 Export All</button></a>
        </div>
        
        <div class="card">
            <h1>✨ Create Subscription (Manual Only)</h1>
            <form action="/generate" method="POST" onsubmit="event.preventDefault();this.submit();">
                <input type="text" name="name" placeholder="Subscription Name (optional)" style="margin-bottom:10px;">
                <textarea name="content" placeholder="Paste your VLESS/Trojan/SS config here..." rows="4" required></textarea>
                
                <div style="margin:10px 0;padding:10px;background:#0d1117;border-radius:6px;">
                    <strong>⏱ Duration:</strong><br>
                    <input type="number" name="duration" value="30" min="1" style="width:80px;"> 
                    <select name="unit" style="width:120px;"><option value="minutes">Min</option><option value="hours">Hours</option><option value="days" selected>Days</option><option value="months">Months</option></select>
                </div>
                
                <div style="margin:10px 0;padding:10px;background:#0d1117;border-radius:6px;">
                    <strong>📱 Max Devices (0 = Unlimited):</strong><br>
                    <input type="number" name="maxDevices" value="0" min="0" placeholder="0">
                </div>
                
                <div style="margin:10px 0;padding:10px;background:#0d1117;border-radius:6px;">
                    <strong>📊 Traffic Limit MB (0 = Unlimited):</strong><br>
                    <input type="number" name="trafficLimit" value="0" min="0" placeholder="0">
                </div>
                
                <button type="submit" class="generate">✨ Generate Link</button>
            </form>
        </div>
        
        <div class="card">
            <h2>📋 My Subscriptions (${visibleLinks.length})</h2>
            ${linksHtml || '<p>No subscriptions. Create one!</p>'}
        </div>
        
        <div id="modal" class="modal"><div class="modal-content"><span class="close" onclick="closeModal()">&times;</span><div id="modalContent"></div></div></div>
    </body></html>`);
});

// ==================== ОБРАБОТЧИКИ ====================
app.post('/generate', isAuthenticated, (req, res) => {
    const id = generateRandomId();
    const duration = parseInt(req.body.duration) || 30;
    const unit = req.body.unit || 'days';
    const trafficLimit = parseInt(req.body.trafficLimit) || 0;
    const maxDevices = parseInt(req.body.maxDevices) || 0;
    
    subscriptions[id] = {
        masterConfig: addPrefix(req.body.content),
        content: addPrefix(req.body.content),
        originalContent: null,
        count: 0,
        devices: {},
        owner: req.session.userId,
        name: req.body.name || `Sub #${id}`,
        trafficLimit: trafficLimit > 0 ? trafficLimit * 1024 * 1024 : 0,
        maxDevices: maxDevices,
        expiryDate: calculateExpiryDate(duration, unit).toISOString(),
        isDestroyed: false,
        createdAt: new Date().toISOString()
    };
    
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
        // Не даем редактировать, если уничтожено (опционально, но логично)
        if (subscriptions[id].isDestroyed) return res.status(400).json({error: 'Cannot edit destroyed sub'});
        
        subscriptions[id].masterConfig = addPrefix(req.body.content);
        subscriptions[id].content = addPrefix(req.body.content);
        updateAllDevicesConfig(id);
        saveToGist();
        res.json({success: true});
    } else { res.status(404).json({error: 'Not found'}); }
});

app.get('/devices/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        res.json(subscriptions[id].devices || {});
    } else { res.status(404).json({error: 'Not found'}); }
});

app.post('/deactivate-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
        const device = subscriptions[linkId].devices[deviceId];
        device.active = false;
        device.name = device.name.replace(': Inactive', '').trim() + ': Inactive';
        device.config = replaceAddressInConfig(device.config, '0.0.0.0:443');
        saveToGist();
        res.json({success: true});
    } else { res.status(404).json({error: 'Not found'}); }
});

app.post('/restore-device/:linkId/:deviceId', isAuthenticated, (req, res) => {
    const { linkId, deviceId } = req.params;
    if (subscriptions[linkId] && subscriptions[linkId].devices && subscriptions[linkId].devices[deviceId]) {
        const device = subscriptions[linkId].devices[deviceId];
        device.active = true;
        device.name = device.name.replace(': Inactive', '').trim();
        device.config = subscriptions[linkId].masterConfig;
        saveToGist();
        res.json({success: true});
    } else { res.status(404).json({error: 'Not found'}); }
});

// API Продления (теперь обновляет и лимиты устройств/трафика)
app.post('/api/extend/:id', isAuthenticated, express.json(), (req, res) => {
    const { id } = req.params;
    const { duration, unit, maxDevices, trafficLimit } = req.body;
    
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        subscriptions[id].expiryDate = calculateExpiryDate(duration, unit).toISOString();
        if (maxDevices !== undefined) subscriptions[id].maxDevices = parseInt(maxDevices);
        if (trafficLimit !== undefined) subscriptions[id].trafficLimit = parseInt(trafficLimit) > 0 ? parseInt(trafficLimit) * 1024 * 1024 : 0;
        
        // Если была уничтожена - восстанавливаем
        if (subscriptions[id].isDestroyed && subscriptions[id].originalContent) {
            subscriptions[id].masterConfig = subscriptions[id].originalContent;
            subscriptions[id].content = subscriptions[id].originalContent;
            subscriptions[id].isDestroyed = false;
            subscriptions[id].originalContent = null;
            if (subscriptions[id].devices) {
                for (const devId in subscriptions[id].devices) {
                    subscriptions[id].devices[devId].active = true;
                    subscriptions[id].devices[devId].config = subscriptions[id].masterConfig;
                }
            }
        }
        saveToGist();
        res.json({success: true});
    } else { res.status(404).json({error: 'Not found'}); }
});

// 🔥 ГЛАВНЫЙ ОБРАБОТЧИК ПОДПИСКИ С ЛИМИТОМ УСТРОЙСТВ
app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (!subscriptions[id]) return res.status(404).send('Link not found');
    
    const sub = subscriptions[id];
    let deviceId = req.query.deviceId;
    
    if (!deviceId) {
        deviceId = uuidv4();
        return res.redirect(`/p/${id}?deviceId=${deviceId}`);
    }
    
    sub.count = (sub.count || 0) + 1;
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || '0.0.0.0';
    const country = await getCountryFromIP(ip);
    
    if (!sub.devices) sub.devices = {};
    
    // Проверяем лимит устройств ТОЛЬКО если это новое устройство
    if (!sub.devices[deviceId]) {
        if (isDeviceLimitExceeded(sub)) {
            console.log(`🚫 Device limit exceeded for ${id}. IP: ${ip}`);
            // Отдаем destroy config, так как лимит исчерпан
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            return res.send(DESTROY_CONFIG);
        }
        
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
        if (device.country !== country) device.country = country;
        // Обновляем конфиг если активен и не уничтожен
        if (device.active && !sub.isDestroyed && device.config !== sub.masterConfig) {
            device.config = sub.masterConfig;
        }
        // Учет трафика (размер ответа)
        const configSize = Buffer.byteLength(device.config, 'utf8');
        device.trafficUsed = (device.trafficUsed || 0) + configSize;
    }
    
    // Проверка глобальных лимитов
    if (!sub.isDestroyed && (isSubscriptionExpired(sub) || isTrafficLimitExceeded(sub))) {
        console.log(`🔥 Sub ${id} expired/limit reached -> Destroy`);
        if (!sub.originalContent) sub.originalContent = sub.masterConfig;
        applyDestroyConfig(sub);
    }
    
    saveToGist();
    
    const device = sub.devices[deviceId];
    const configToSend = (device?.active && !sub.isDestroyed) ? device.config : DESTROY_CONFIG;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(configToSend);
});

app.post('/delete/:id', isAuthenticated, (req, res) => {
    if (subscriptions[req.params.id] && (subscriptions[req.params.id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        delete subscriptions[req.params.id];
        saveToGist();
    }
    res.redirect('/');
});

app.post('/destroy/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        if (!subscriptions[id].originalContent) subscriptions[id].originalContent = subscriptions[id].masterConfig || subscriptions[id].content;
        applyDestroyConfig(subscriptions[id]);
        saveToGist();
    }
    res.redirect('/');
});

app.post('/restore/:id', isAuthenticated, (req, res) => {
    const id = req.params.id;
    if (subscriptions[id] && subscriptions[id].originalContent && (subscriptions[id].owner === req.session.userId || users[req.session.userId]?.role !== 'user')) {
        subscriptions[id].masterConfig = subscriptions[id].originalContent;
        subscriptions[id].content = subscriptions[id].originalContent;
        subscriptions[id].originalContent = null;
        subscriptions[id].isDestroyed = false;
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
    return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    console.log(`🚀 VPN Admin Panel v1.7 running on port ${PORT}`);
    loadUsers();
    await loadFromGist();
    checkSubscriptions();
});
