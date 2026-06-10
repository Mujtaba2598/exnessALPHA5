const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'halal-exness-secret-key-2024';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

// ==================== DATA SETUP ====================
const dataDir = path.join(__dirname, 'data');
const tradesDir = path.join(dataDir, 'trades');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(tradesDir)) fs.mkdirSync(tradesDir, { recursive: true });

const usersFile = path.join(dataDir, 'users.json');
const pendingFile = path.join(dataDir, 'pending.json');

// Default owner account
if (!fs.existsSync(usersFile)) {
    const defaultUsers = {
        "mujtabahatif@gmail.com": {
            email: "mujtabahatif@gmail.com",
            password: bcrypt.hashSync("Mujtabah@2598", 10),
            isOwner: true,
            isApproved: true,
            isBlocked: false,
            exnessAccount: "",
            exnessPassword: "",
            exnessServer: "",
            lastBalance: 0,
            createdAt: new Date().toISOString()
        }
    };
    fs.writeFileSync(usersFile, JSON.stringify(defaultUsers, null, 2));
}
if (!fs.existsSync(pendingFile)) fs.writeFileSync(pendingFile, JSON.stringify({}));

function readUsers() { return JSON.parse(fs.readFileSync(usersFile)); }
function writeUsers(users) { fs.writeFileSync(usersFile, JSON.stringify(users, null, 2)); }
function readPending() { return JSON.parse(fs.readFileSync(pendingFile)); }
function writePending(pending) { fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2)); }

function encrypt(text) {
    if (!text) return "";
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return "";
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== AUTH ROUTES ====================
app.post('/api/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    
    const users = readUsers();
    if (users[email]) return res.status(400).json({ success: false, message: 'User exists' });
    
    const pending = readPending();
    if (pending[email]) return res.status(400).json({ success: false, message: 'Already pending' });
    
    pending[email] = { email, password: bcrypt.hashSync(password, 10), requestedAt: new Date().toISOString() };
    writePending(pending);
    res.json({ success: true, message: 'Request sent to owner' });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const users = readUsers();
    const user = users[email];
    
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isApproved && !user.isOwner) return res.status(401).json({ success: false, message: 'Account not approved' });
    if (user.isBlocked) return res.status(401).json({ success: false, message: 'Account blocked' });
    
    const token = jwt.sign({ email, isOwner: user.isOwner || false }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, isOwner: user.isOwner || false });
});

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/pending-users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const pending = readPending();
    res.json({ success: true, pending: Object.keys(pending).map(email => ({ email, requestedAt: pending[email].requestedAt })) });
});

app.post('/api/admin/approve-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    const users = readUsers();
    users[email] = { 
        email, 
        password: pending[email].password, 
        isOwner: false, 
        isApproved: true, 
        isBlocked: false, 
        exnessAccount: "",
        exnessPassword: "",
        exnessServer: "",
        lastBalance: 0,
        createdAt: pending[email].requestedAt 
    };
    writeUsers(users);
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `Approved ${email}` });
});

app.post('/api/admin/reject-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `Rejected ${email}` });
});

app.post('/api/admin/toggle-block', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const users = readUsers();
    if (!users[email]) return res.status(404).json({ success: false });
    users[email].isBlocked = !users[email].isBlocked;
    writeUsers(users);
    res.json({ success: true, message: `User ${email} is now ${users[email].isBlocked ? 'BLOCKED' : 'ACTIVE'}` });
});

app.get('/api/admin/users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const users = readUsers();
    const list = Object.keys(users).map(email => ({ 
        email, 
        hasExnessCreds: !!users[email].exnessAccount, 
        isOwner: users[email].isOwner, 
        isApproved: users[email].isApproved, 
        isBlocked: users[email].isBlocked,
        balance: users[email].lastBalance || 0
    }));
    res.json({ success: true, users: list });
});

app.get('/api/admin/user-balances', authenticate, async (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    
    const users = readUsers();
    const balances = {};
    
    for (const [email, userData] of Object.entries(users)) {
        if (!userData.exnessAccount) {
            balances[email] = { balance: 0, hasConnection: false };
            continue;
        }
        
        try {
            const exnessAccount = decrypt(userData.exnessAccount);
            const exnessPassword = decrypt(userData.exnessPassword);
            const exnessServer = decrypt(userData.exnessServer);
            
            const result = await sendToBridge('connect', {
                login: parseInt(exnessAccount),
                password: exnessPassword,
                server: exnessServer
            });
            
            balances[email] = { 
                balance: result.balance, 
                hasConnection: true,
                lastUpdated: new Date().toISOString()
            };
            
            userData.lastBalance = result.balance;
            writeUsers(users);
        } catch (error) {
            balances[email] = { balance: userData.lastBalance || 0, hasConnection: false, error: error.message };
        }
    }
    
    res.json({ success: true, balances });
});

app.get('/api/admin/all-trades', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    
    const allTrades = {};
    const files = fs.readdirSync(tradesDir);
    
    for (const file of files) {
        if (file === '.gitkeep') continue;
        const userId = file.replace('.json', '');
        const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file)));
        allTrades[userId] = trades;
    }
    
    res.json({ success: true, trades: allTrades });
});

// ==================== EXNESS INTEGRATION (via Python Bridge) ====================
let bridgeWs = null;
let pendingRequests = new Map();
let requestId = 0;

function connectToBridge() {
    const ws = new WebSocket('ws://localhost:5001');
    
    ws.on('open', () => {
        console.log('✅ Connected to Python Bridge');
        bridgeWs = ws;
    });
    
    ws.on('message', (data) => {
        const response = JSON.parse(data);
        if (pendingRequests.has(response.id)) {
            const { resolve, reject } = pendingRequests.get(response.id);
            pendingRequests.delete(response.id);
            if (response.success) {
                resolve(response.data);
            } else {
                reject(response.error);
            }
        }
    });
    
    ws.on('error', (err) => {
        console.error('Bridge WebSocket error:', err);
    });
    
    ws.on('close', () => {
        console.log('❌ Bridge disconnected, reconnecting in 5 seconds...');
        bridgeWs = null;
        setTimeout(connectToBridge, 5000);
    });
}

setTimeout(connectToBridge, 1000);

function sendToBridge(action, params) {
    return new Promise((resolve, reject) => {
        if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
            reject(new Error('Bridge not connected'));
            return;
        }
        
        const id = requestId++;
        pendingRequests.set(id, { resolve, reject });
        bridgeWs.send(JSON.stringify({ id, action, params }));
        
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Request timeout'));
            }
        }, 30000);
    });
}

// ==================== EXNESS ACCOUNT ROUTES ====================
app.post('/api/set-exness-creds', authenticate, async (req, res) => {
    try {
        const { exnessAccount, exnessPassword, exnessServer } = req.body;
        if (!exnessAccount || !exnessPassword || !exnessServer) {
            return res.status(400).json({ success: false, message: 'All fields required' });
        }
        
        const result = await sendToBridge('connect', {
            login: parseInt(exnessAccount),
            password: exnessPassword,
            server: exnessServer
        });
        
        const users = readUsers();
        users[req.user.email].exnessAccount = encrypt(exnessAccount);
        users[req.user.email].exnessPassword = encrypt(exnessPassword);
        users[req.user.email].exnessServer = encrypt(exnessServer);
        users[req.user.email].lastBalance = result.balance;
        writeUsers(users);
        
        res.json({ success: true, message: `Connected! Balance: $${result.balance.toFixed(2)}`, balance: result.balance });
    } catch (error) {
        console.error('Exness connection error:', error);
        res.status(401).json({ success: false, message: error.message });
    }
});

app.post('/api/connect-exness', authenticate, async (req, res) => {
    try {
        const users = readUsers();
        const user = users[req.user.email];
        
        if (!user || !user.exnessAccount) {
            return res.status(400).json({ success: false, message: 'No Exness credentials saved.' });
        }
        
        const exnessAccount = decrypt(user.exnessAccount);
        const exnessPassword = decrypt(user.exnessPassword);
        const exnessServer = decrypt(user.exnessServer);
        
        const result = await sendToBridge('connect', {
            login: parseInt(exnessAccount),
            password: exnessPassword,
            server: exnessServer
        });
        
        user.lastBalance = result.balance;
        writeUsers(users);
        
        res.json({ success: true, balance: result.balance, totalBalance: result.balance, message: `Connected! Balance: $${result.balance.toFixed(2)}` });
    } catch (error) {
        console.error('Connection error:', error);
        res.status(401).json({ success: false, message: error.message });
    }
});

app.get('/api/get-exness-creds', authenticate, (req, res) => {
    const users = readUsers();
    const user = users[req.user.email];
    if (!user || !user.exnessAccount) return res.json({ success: false });
    res.json({ 
        success: true, 
        exnessAccount: decrypt(user.exnessAccount),
        exnessServer: decrypt(user.exnessServer)
    });
});

// ==================== DYNAMIC AI TRADING ENGINE ====================
const activeSessions = {};

class HalalTradingEngine {
    constructor(sessionId, userEmail, config) {
        this.sessionId = sessionId;
        this.userEmail = userEmail;
        this.config = config;
        this.isActive = true;
        this.currentProfit = 0;
        this.trades = [];
        this.winStreak = 0;
        this.analysisInterval = null;
        this.monitorInterval = null;
        this.startTime = Date.now();
        this.openPositions = new Map();
    }
    
    async start() {
        console.log(`🕋 Starting Halal trading engine for ${this.userEmail}`);
        
        // Analysis every 5 seconds
        this.analysisInterval = setInterval(async () => {
            if (!this.isActive) return;
            
            const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
            if (elapsedHours >= this.config.timeLimit) {
                await this.stop();
                return;
            }
            
            if (this.currentProfit >= this.config.targetProfit) {
                console.log(`🎯 Target reached! Total profit: $${this.currentProfit.toFixed(2)}`);
                await this.stop();
                return;
            }
            
            for (const symbol of this.config.tradingPairs) {
                if (!this.isActive) break;
                
                const hasPosition = this.openPositions.has(symbol);
                
                if (!hasPosition) {
                    try {
                        const signal = await sendToBridge('getSignal', { symbol });
                        
                        if (signal.action === 'BUY' && signal.confidence >= 0.65) {
                            await this.executeTrade(symbol, 'buy', signal);
                        } else if (signal.action === 'SELL' && signal.confidence >= 0.65) {
                            await this.executeTrade(symbol, 'sell', signal);
                        }
                    } catch (error) {
                        console.error(`Analysis error for ${symbol}:`, error.message);
                    }
                }
            }
        }, 5000);
        
        // Monitor positions every 2 seconds
        this.monitorInterval = setInterval(async () => {
            if (!this.isActive) return;
            
            for (const [symbol, position] of this.openPositions) {
                try {
                    const priceData = await sendToBridge('getPrice', { symbol });
                    let currentProfit = 0;
                    let currentProfitPercent = 0;
                    
                    if (position.side === 'buy') {
                        currentProfit = (priceData.bid - position.entryPrice) * position.volume * 100000;
                        currentProfitPercent = ((priceData.bid - position.entryPrice) / position.entryPrice) * 100;
                    } else {
                        currentProfit = (position.entryPrice - priceData.ask) * position.volume * 100000;
                        currentProfitPercent = ((position.entryPrice - priceData.ask) / position.entryPrice) * 100;
                    }
                    
                    const holdingTime = (Date.now() - position.openedAt) / 1000;
                    
                    const shouldClose = await sendToBridge('shouldClosePosition', {
                        symbol: symbol,
                        entryPrice: position.entryPrice,
                        currentPrice: priceData.bid,
                        currentProfitPercent: currentProfitPercent,
                        side: position.side,
                        holdingTime: holdingTime,
                        positionId: position.orderId
                    });
                    
                    if (shouldClose.close) {
                        console.log(`📈 AI DECISION: Closing ${symbol} ${position.side} | Profit: ${currentProfitPercent.toFixed(2)}% | Reason: ${shouldClose.reason}`);
                        await this.closePosition(symbol, position, currentProfit, currentProfitPercent);
                    }
                } catch (error) {
                    console.error(`Monitor error for ${symbol}:`, error.message);
                }
            }
        }, 2000);
    }
    
    async executeTrade(symbol, side, signal) {
        if (this.openPositions.has(symbol)) return;
        
        try {
            const balance = await sendToBridge('getBalance');
            let volume = this.config.investmentAmount / 100000;
            
            if (volume < 0.01) volume = 0.01;
            if (volume > 1.0) volume = 1.0;
            
            if (balance < this.config.investmentAmount + 50) {
                console.log(`⚠️ Insufficient balance: $${balance.toFixed(2)}`);
                return;
            }
            
            const priceData = await sendToBridge('getPrice', { symbol });
            const entryPrice = side === 'buy' ? priceData.ask : priceData.bid;
            const positionValue = volume * 100000 * entryPrice;
            
            console.log(`📈 AI DECISION: Opening ${side.toUpperCase()} for ${symbol} | Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
            
            const result = await sendToBridge('placeOrder', {
                symbol: symbol,
                volume: volume,
                side: side,
                sl: null,
                tp: null
            });
            
            this.openPositions.set(symbol, {
                side: side,
                volume: volume,
                entryPrice: entryPrice,
                positionValue: positionValue,
                orderId: result.orderId,
                openedAt: Date.now(),
                aiConfidence: signal.confidence,
                aiReason: signal.reasons ? signal.reasons[0] : ''
            });
            
            this.trades.unshift({
                symbol: symbol,
                side: `${side.toUpperCase()} OPEN`,
                entryPrice: entryPrice.toFixed(5),
                volume: volume,
                aiConfidence: `${(signal.confidence * 100).toFixed(0)}%`,
                aiReason: signal.reasons ? signal.reasons[0] : '',
                timestamp: new Date().toISOString()
            });
            
            console.log(`✅ Halal ${side.toUpperCase()} opened for ${symbol} at $${entryPrice.toFixed(5)}`);
        } catch (error) {
            console.error(`Trade execution error:`, error.message);
        }
    }
    
    async closePosition(symbol, position, profit, profitPercent) {
        try {
            await sendToBridge('closeOrder', { orderId: position.orderId });
            
            this.currentProfit += profit;
            this.winStreak = profit > 0 ? this.winStreak + 1 : 0;
            
            this.trades.unshift({
                symbol: symbol,
                side: `${position.side.toUpperCase()} CLOSED`,
                entryPrice: position.entryPrice.toFixed(5),
                profit: profit.toFixed(2),
                profitPercent: profitPercent.toFixed(2),
                aiEntryConfidence: `${(position.aiConfidence * 100).toFixed(0)}%`,
                aiEntryReason: position.aiReason,
                timestamp: new Date().toISOString()
            });
            
            const tradeFile = path.join(tradesDir, this.userEmail.replace(/[^a-z0-9]/gi, '_') + '.json');
            let allTrades = [];
            if (fs.existsSync(tradeFile)) allTrades = JSON.parse(fs.readFileSync(tradeFile));
            allTrades.unshift({
                symbol: symbol,
                side: position.side,
                entryPrice: position.entryPrice,
                profit: profit,
                profitPercent: profitPercent,
                aiConfidence: position.aiConfidence,
                aiReason: position.aiReason,
                timestamp: new Date().toISOString()
            });
            fs.writeFileSync(tradeFile, JSON.stringify(allTrades, null, 2));
            
            this.openPositions.delete(symbol);
            
            const profitSymbol = profit >= 0 ? '+' : '';
            console.log(`✅ AI CLOSED ${symbol} | Profit: ${profitSymbol}$${profit.toFixed(2)} (${profitPercent.toFixed(2)}%) | Total: $${this.currentProfit.toFixed(2)}`);
        } catch (error) {
            console.error(`Close error:`, error.message);
        }
    }
    
    async stop() {
        console.log(`🛑 Stopping Halal trading engine for ${this.userEmail}`);
        this.isActive = false;
        
        if (this.analysisInterval) clearInterval(this.analysisInterval);
        if (this.monitorInterval) clearInterval(this.monitorInterval);
        
        for (const [symbol, position] of this.openPositions) {
            try {
                const priceData = await sendToBridge('getPrice', { symbol });
                let profit = 0;
                let profitPercent = 0;
                
                if (position.side === 'buy') {
                    profit = (priceData.bid - position.entryPrice) * position.volume * 100000;
                    profitPercent = ((priceData.bid - position.entryPrice) / position.entryPrice) * 100;
                } else {
                    profit = (position.entryPrice - priceData.ask) * position.volume * 100000;
                    profitPercent = ((position.entryPrice - priceData.ask) / position.entryPrice) * 100;
                }
                
                await this.closePosition(symbol, position, profit, profitPercent);
            } catch (error) {
                console.error(`Stop close error:`, error.message);
            }
        }
    }
    
    getStatus() {
        const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        const timeRemaining = Math.max(0, this.config.timeLimit - elapsedHours);
        const progressPercent = this.config.targetProfit > 0 ? (this.currentProfit / this.config.targetProfit) * 100 : 0;
        
        return {
            isActive: this.isActive,
            currentProfit: this.currentProfit,
            targetProfit: this.config.targetProfit,
            winStreak: this.winStreak,
            timeRemaining: timeRemaining,
            progressPercent: progressPercent,
            openPositions: this.openPositions.size,
            trades: this.trades.slice(0, 30)
        };
    }
}

const engines = {};

app.post('/api/start-trading', authenticate, async (req, res) => {
    try {
        const { investmentAmount, targetProfit, timeLimit, tradingPairs } = req.body;
        
        console.log('📊 Halal trading start request:', { investmentAmount, targetProfit, timeLimit });
        
        if (investmentAmount < 3) return res.status(400).json({ success: false, message: 'Minimum investment is $3' });
        if (targetProfit < 1) return res.status(400).json({ success: false, message: 'Target profit must be at least $1' });
        if (!timeLimit || timeLimit < 0.1) return res.status(400).json({ success: false, message: 'Time limit must be at least 0.1 hours' });

        const users = readUsers();
        const user = users[req.user.email];
        if (!user.exnessAccount) return res.status(400).json({ success: false, message: 'Please add Exness credentials first' });

        const exnessAccount = decrypt(user.exnessAccount);
        const exnessPassword = decrypt(user.exnessPassword);
        const exnessServer = decrypt(user.exnessServer);
        
        const testResult = await sendToBridge('connect', {
            login: parseInt(exnessAccount),
            password: exnessPassword,
            server: exnessServer
        });
        
        if (!testResult || testResult.balance < investmentAmount) {
            return res.status(400).json({ success: false, message: `Insufficient balance. You have $${testResult?.balance?.toFixed(2) || 0} USD, need $${investmentAmount}` });
        }

        const sessionId = 'session_' + Date.now() + '_' + req.user.email.replace(/[^a-z0-9]/gi, '_');
        
        const config = {
            investmentAmount: investmentAmount,
            targetProfit: targetProfit,
            timeLimit: timeLimit,
            tradingPairs: tradingPairs || ['EURUSD', 'GBPUSD', 'XAUUSD']
        };
        
        const engine = new HalalTradingEngine(sessionId, req.user.email, config);
        engines[sessionId] = engine;
        await engine.start();
        
        console.log(`✅ Halal trading started for ${req.user.email}`);
        res.json({ 
            success: true, 
            sessionId, 
            message: `✅ HALAL TRADING STARTED! AI analyzes continuously and closes positions at maximum profit. No fixed take profit.` 
        });
    } catch (error) {
        console.error('Start trading error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/stop-trading', authenticate, (req, res) => {
    const { sessionId } = req.body;
    if (engines[sessionId]) {
        engines[sessionId].stop();
        delete engines[sessionId];
    }
    res.json({ success: true, message: 'Trading stopped' });
});

app.post('/api/trading-update', authenticate, (req, res) => {
    const { sessionId } = req.body;
    const engine = engines[sessionId];
    if (!engine) return res.json({ success: true, currentProfit: 0, newTrades: [], isActive: false });
    
    const status = engine.getStatus();
    res.json({
        success: true,
        currentProfit: status.currentProfit,
        targetProfit: status.targetProfit,
        newTrades: status.trades,
        winStreak: status.winStreak,
        timeRemaining: status.timeRemaining,
        progressPercent: status.progressPercent,
        openPositions: status.openPositions,
        isActive: status.isActive
    });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🕋 100% HALAL EXNESS TRADING BOT`);
    console.log(`✅ Server: http://localhost:${PORT}`);
    console.log(`✅ Login: mujtabahatif@gmail.com / Mujtabah@2598`);
    console.log(`✅ Minimum Investment: $3`);
    console.log(`✅ NO FIXED TAKE PROFIT - AI decides when to close`);
    console.log(`✅ AI analyzes continuously | Unlimited concurrent trades`);
    console.log(`✅ Admin panel shows all users' balances and trades`);
    console.log(`✅ 100% Halal - No Riba, No Gharar, No Maysir\n`);
});
