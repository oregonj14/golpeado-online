const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

// CONFIGURACIÓN ANTI-DESCONEXIONES BLINDADA
const io = new Server(server, {
    pingTimeout: 60000, // Da mucho más margen a los celulares
    pingInterval: 25000
});

app.use(express.json());
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.use(express.static(__dirname));

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/saloon_golpeado';
mongoose.connect(MONGO_URI).catch(err => console.error(err));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    victories: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    unlockedChars: { type: [String], default: ['🤠', '🤖', '💀', '🦊', '🦁'] },
    activeEffect: { type: String, default: '' },
    unlockedEffects: { type: [String], default: [] }
});
const User = mongoose.model('User', UserSchema);

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (await User.findOne({ username })) return res.status(400).json({ error: 'Nickname en uso' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'Cuenta creada' });
    } catch (e) { res.status(500).json({ error: 'Error BD.' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Credenciales inválidas' });
        
        let changed = false;
        ['🤠', '🤖', '💀', '🦊', '🦁'].forEach(c => { if (!user.unlockedChars.includes(c)) { user.unlockedChars.push(c); changed = true; } });
        if (changed) await user.save(); 

        res.status(200).json({ user });
    } catch (e) { res.status(500).json({ error: 'Error BD.' }); }
});

app.get('/api/ranking', async (req, res) => {
    try {
        const allUsers = await User.find({}, 'username victories').sort({ victories: -1 }).limit(100);
        res.status(200).json(allUsers);
    } catch (e) { res.status(500).json({ error: 'Error Ranking' }); }
});

app.post('/api/buy', async (req, res) => {
    try {
        const { username, item, price, type } = req.body;
        const user = await User.findOne({ username });
        if (!user || user.points < price) return res.status(400).json({ error: 'Fichas insuficientes' });
        if (type === 'char' && user.unlockedChars.includes(item)) return res.status(400).json({ error: 'Ya lo tienes' });
        if (type === 'effect' && user.unlockedEffects.includes(item)) return res.status(400).json({ error: 'Ya lo tienes' });

        user.points -= price;
        if (type === 'char') { user.unlockedChars.push(item); } else { user.unlockedEffects.push(item); user.activeEffect = item; }
        await user.save();
        res.status(200).json({ points: user.points, unlockedChars: user.unlockedChars, activeEffect: user.activeEffect, message: 'Comprado!' });
    } catch (e) { res.status(500).json({ error: 'Error Transacción' }); }
});

const rooms = {};
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const broadcastPublicRooms = () => { io.emit('update_public_rooms', Object.values(rooms).map(r => ({ id: r.id, host: r.players[0]?.name || 'Desc', players: r.players.length, max: r.maxPlayers, state: r.state }))); };

const getCardValue = (rank) => {
    if (['A', '10', 'J', 'Q', 'K'].includes(rank)) return 10;
    if (rank === 'Joker') return 0;
    return parseInt(rank);
};

const createDeck = (jokerCount) => {
    let deck = [];
    suits.forEach(suit => { ranks.forEach(rank => { deck.push({ suit, rank, value: getCardValue(rank), id: `${rank}_${suit}` }); }); });
    for (let i = 1; i <= jokerCount; i++) { deck.push({ suit: 'none', rank: 'Joker', value: 0, id: `Joker_${i}_${Date.now()}` }); }
    return deck.sort(() => Math.random() - 0.5);
};

// MOTOR MATEMÁTICO
const isValidMelding = (cards) => {
    if (cards.length < 3 || cards.length > 4) return false;
    let jokers = cards.filter(c => c.id.includes('Joker')).length;
    let normals = cards.filter(c => !c.id.includes('Joker'));
    if (normals.length <= 1) return true;

    if (normals.every(c => c.rank === normals[0].rank)) {
        let uniqueSuits = new Set(normals.map(c => c.suit)).size;
        if (uniqueSuits === normals.length) return true; 
    }

    if (normals.every(c => c.suit === normals[0].suit)) {
        const checkSeq = (vals) => {
            let sorted = [...vals].sort((a, b) => a - b);
            if (new Set(sorted).size !== sorted.length) return false; 
            let gaps = 0;
            for (let i = 0; i < sorted.length - 1; i++) gaps += (sorted[i+1] - sorted[i] - 1);
            return gaps <= jokers; 
        };

        let valLow = normals.map(c => { if (c.rank === 'A') return 1; if (['J', 'Q', 'K'].includes(c.rank)) return c.rank==='J'?11 : c.rank==='Q'?12 : 13; return parseInt(c.rank); });
        if (checkSeq(valLow)) return true;

        let valHigh = normals.map(c => { if (c.rank === 'A') return 14; if (c.rank === '2') return 15; if (['J', 'Q', 'K'].includes(c.rank)) return c.rank==='J'?11 : c.rank==='Q'?12 : 13; return parseInt(c.rank); });
        if (checkSeq(valHigh)) return true;
    }
    return false;
};

const getSubsets = (array) => {
    let subsets = [];
    const generate = (current, start) => {
        if (current.length === 3 || current.length === 4) subsets.push([...current]);
        if (current.length === 4) return;
        for (let i = start; i < array.length; i++) { current.push(array[i]); generate(current, i + 1); current.pop(); }
    };
    generate([], 0); return subsets;
};

const getOptimalFinalScoreAndHand = (hand, exposedGroups) => {
    let bestScore = Infinity;
    let bestArrangement = [];

    function evaluate(currentHand, currentTableGroups, currentFormedGroups) {
        let score = currentHand.reduce((acc, c) => acc + (c.id.includes('Joker') ? 0 : c.value), 0);
        if (score < bestScore) { 
            bestScore = score; 
            let sortedLeftovers = [...currentHand].sort((a, b) => b.value - a.value);
            bestArrangement = [];
            currentFormedGroups.forEach(g => { bestArrangement.push(...g); });
            bestArrangement.push(...sortedLeftovers);
        }

        let subsets = getSubsets(currentHand);
        for (let subset of subsets) {
            if (isValidMelding(subset)) {
                let remaining = [...currentHand];
                for (let card of subset) { let idx = remaining.findIndex(c => c.id === card.id); remaining.splice(idx, 1); }
                evaluate(remaining, currentTableGroups, [...currentFormedGroups, subset]);
            }
        }

        for (let i = 0; i < currentHand.length; i++) {
            let card = currentHand[i];
            for (let g = 0; g < currentTableGroups.length; g++) {
                let group = currentTableGroups[g];
                if (group.cards.length < 4 && isValidMelding([...group.cards, card])) {
                    let remainingHand = [...currentHand]; remainingHand.splice(i, 1);
                    let nextGroups = currentTableGroups.map((tg, idx) => { if (idx === g) return { ...tg, cards: [...tg.cards, card] }; return tg; });
                    evaluate(remainingHand, nextGroups, currentFormedGroups);
                }
            }
        }
    }
    evaluate(hand, exposedGroups || [], []);
    return { score: bestScore, orderedHand: bestArrangement }; 
};

const hasValidGroup = (hand) => getOptimalFinalScoreAndHand(hand, []).score < hand.reduce((sum, c) => sum + (c.id.includes('Joker') ? 0 : c.value), 0);
const canPlugIn = (group, card) => group.length < 4 && isValidMelding([...group, card]);

const sanitizeRoom = (room) => {
    let activePlayers = room.players.filter(p => !p.surrendered && !p.offline);
    let currentActiveIdx = activePlayers.findIndex(p => p.id === room.players[room.turnIndex]?.id);
    let nextTurnName = "...";
    if (activePlayers.length > 1 && currentActiveIdx !== -1) { let nextPlayer = activePlayers[(currentActiveIdx + 1) % activePlayers.length]; if (nextPlayer) nextTurnName = nextPlayer.name; }

    return {
        id: room.id, hostId: room.players[0]?.id, 
        players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, character: p.character, ready: p.ready, surrendered: p.surrendered, offline: p.offline, inLobby: p.inLobby, activeEffect: p.activeEffect, isBot: p.isBot })),
        spectators: room.spectators.map(s => ({ id: s.id, name: s.name })), topDiscard: room.discardPile[room.discardPile.length - 1] || null, 
        turnId: room.players[room.turnIndex]?.id, deckCount: room.deck.length, phase: room.phase, exposedGroups: room.exposedGroups, maxPlayers: room.maxPlayers, 
        jokerCount: room.jokerCount, turnTime: room.turnTime, state: room.state, startingPlayerId: room.startingPlayerId, history: room.history, timerExpires: room.timerExpires, nextTurnName: nextTurnName
    };
};

// --- MOTOR DE BOTS Y TURNOS ---
const startTurnTimer = (roomId) => {
    const room = rooms[roomId]; if (!room || room.state !== 'playing') return;
    clearTimeout(room.turnTimer);
    
    let currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.isBot) {
        room.timerExpires = Date.now() + 4000; // Bots juegan en 4 segundos
        executeBotPlay(roomId, currentPlayer);
    } else {
        const ms = room.turnTime * 1000; room.timerExpires = Date.now() + ms;
        room.turnTimer = setTimeout(() => { executeAutoPlay(roomId); }, ms);
    }
};

const executeBotPlay = (roomId, bot) => {
    const room = rooms[roomId]; if (!room || room.state !== 'playing') return;
    
    setTimeout(() => {
        // FASE 1: ROBAR
        let tookDiscard = false;
        let topDiscard = room.discardPile[room.discardPile.length - 1];
        
        // Bots Lvl 3+ evalúan si el pozo les sirve
        if (topDiscard && bot.difficulty >= 3) {
            let simHand = [...bot.hand, topDiscard];
            if (getOptimalFinalScoreAndHand(simHand, room.exposedGroups).score < getOptimalFinalScoreAndHand(bot.hand, room.exposedGroups).score) {
                room.discardPile.pop(); bot.hand.push(topDiscard); tookDiscard = true;
            }
        }
        
        if (!tookDiscard) {
            if (room.deck.length === 0) { room.deck = room.discardPile.sort(() => Math.random() - 0.5); room.discardPile = [room.deck.pop()]; }
            bot.hand.push(room.deck.pop());
        }

        room.phase = 'discard';
        io.to(roomId).emit('update_game', sanitizeRoom(room));

        // FASE 2: GOLPEAR Y DESCARTAR
        setTimeout(() => {
            let finalOpt = getOptimalFinalScoreAndHand(bot.hand, room.exposedGroups);
            let hasExposed = room.exposedGroups.some(g => g.ownerName === bot.name);
            let canKnock = hasExposed || (finalOpt.score < bot.hand.reduce((acc, c) => acc + (c.id.includes('Joker') ? 0 : c.value), 0));
            
            // Niveles de Knocking: Lvl 1 nunca golpea. Lvl 2: < 20pts. Lvl 3: < 15pts. Lvl 4: < 10pts. Lvl 5: < 5pts.
            let knockThreshold = 25 - (bot.difficulty * 5);
            if (bot.difficulty >= 2 && canKnock && finalOpt.score <= knockThreshold) {
                return forceGameOver(roomId, bot.id);
            }

            // Descarte: Si Lvl >= 2 tira la carta muerta más alta. Si Lvl 1 tira aleatoria.
            let cardToDiscard;
            if (bot.difficulty >= 2 && finalOpt.orderedHand.length > 0) {
                let dropId = finalOpt.orderedHand[finalOpt.orderedHand.length - 1].id;
                cardToDiscard = bot.hand.find(c => c.id === dropId);
            } else {
                cardToDiscard = bot.hand[Math.floor(Math.random() * bot.hand.length)];
            }
            
            if (!cardToDiscard) cardToDiscard = bot.hand[0];
            let idx = bot.hand.findIndex(c => c.id === cardToDiscard.id);
            bot.hand.splice(idx, 1); room.discardPile.push(cardToDiscard);

            io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `🤖 ${bot.name} terminó su turno.`, character: '👾' });
            nextTurn(roomId);

        }, 1500);

    }, 1500);
};

const executeAutoPlay = (roomId) => {
    const room = rooms[roomId]; if (!room) return;
    const player = room.players[room.turnIndex]; if (!player) return;

    if (room.phase === 'draw') {
        if (room.deck.length === 0 && room.discardPile.length > 1) { const topDiscard = room.discardPile.pop(); room.deck = room.discardPile.sort(() => Math.random() - 0.5); room.discardPile = [topDiscard]; }
        let card = room.deck.pop(); if (card) player.hand.push(card);
    }
    
    let candidates = player.hand.filter(c => !c.id.includes('Joker'));
    if (candidates.length === 0 && player.hand.length > 0) candidates = player.hand;

    if (candidates.length > 0) {
        const dropCard = candidates[Math.floor(Math.random() * candidates.length)];
        const dropIdx = player.hand.findIndex(c => c.id === dropCard.id);
        player.hand.splice(dropIdx, 1); room.discardPile.push(dropCard);
    }

    io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `⏳ Tiempo agotado. Auto-descarte para ${player.name}.`, character: '🤖' });
    io.to(player.id).emit('update_hand', player.hand); nextTurn(roomId);
};

const nextTurn = (roomId) => {
    const room = rooms[roomId]; if (!room) return;
    let attempts = 0;
    do { 
        room.turnIndex = (room.turnIndex + 1) % room.players.length; attempts++; 
    } while ((room.players[room.turnIndex].surrendered || room.players[room.turnIndex].offline) && attempts < room.players.length);
    
    room.phase = 'draw'; startTurnTimer(roomId); io.to(roomId).emit('update_game', sanitizeRoom(room));
};

const forceGameOver = async (roomId, knockerId) => {
    const room = rooms[roomId]; if (!room) return;
    clearTimeout(room.turnTimer); room.state = 'finished'; room.players.forEach(p => p.inLobby = false); 

    const scores = room.players.map(p => {
        let opt = getOptimalFinalScoreAndHand(p.hand, room.exposedGroups);
        let finalScore = p.surrendered ? opt.score + 20 : opt.score;
        return { id: p.id, name: p.name, score: finalScore, character: p.character, finalHand: opt.orderedHand, turnDiff: 0 };
    });

    let knockerName = 'Mesa Cerrada'; let wasVolteado = false;
    if (knockerId) {
        let knockerIndex = room.players.findIndex(p => p.id === knockerId);
        if (knockerIndex > -1) {
            knockerName = room.players[knockerIndex].name;
            scores.forEach(s => { let pIndex = room.players.findIndex(p => p.id === s.id); s.turnDiff = (pIndex - knockerIndex + room.players.length) % room.players.length; });
        }
    }

    scores.sort((a, b) => { if (a.score === b.score) return a.turnDiff - b.turnDiff; return a.score - b.score; });
    const winner = scores[0];
    if (knockerId && winner.id !== knockerId) wasVolteado = true;

    const allHandsData = room.players.map(p => ({ name: p.name, character: p.character || '🤠', hand: p.hand }));
    room.history.push({ winner: winner.name, score: winner.score, hand: winner.finalHand, wasVolteado: wasVolteado, allHands: allHandsData });

    try { if (mongoose.connection.readyState === 1 && !room.players.find(p=>p.name===winner.name)?.isBot) { await User.findOneAndUpdate({ username: winner.name }, { $inc: { victories: 1, points: 50 } }); } } catch (e) {}

    io.to(roomId).emit('game_over', { scores, knocker: knockerName, winner: winner.name, wasVolteado, exposedGroups: room.exposedGroups });
    io.to(roomId).emit('update_lobby', sanitizeRoom(room)); 
};

// CORRECCIÓN ANTI-DESCONEXIÓN: No elimina jugadores de inmediato
const handleLeaveRoom = (socket, roomId, forceRemove = false) => {
    let room = rooms[roomId]; if (!room) return false; let changed = false;
    let specIdx = room.spectators.findIndex(s => s.id === socket.id);
    if (specIdx > -1) { room.spectators.splice(specIdx, 1); changed = true; }

    let idx = room.players.findIndex(p => p.id === socket.id);
    if (idx > -1) {
        let player = room.players[idx];
        if (forceRemove || room.state === 'waiting' || player.isBot) {
            room.players.splice(idx, 1);
            if (room.players.filter(p=>!p.isBot).length === 0) { clearTimeout(room.turnTimer); delete rooms[roomId]; } 
            else if (room.state === 'playing') {
                if (room.players.length < 2) { clearTimeout(room.turnTimer); room.state = 'waiting'; room.players.forEach(p => p.inLobby = true); io.to(roomId).emit('force_to_lobby'); io.to(roomId).emit('update_lobby', sanitizeRoom(room)); } 
                else { if (room.turnIndex === idx) { room.turnIndex = room.turnIndex % room.players.length; room.phase = 'draw'; startTurnTimer(roomId); } else if (room.turnIndex > idx) { room.turnIndex--; } io.to(roomId).emit('update_game', sanitizeRoom(room)); }
            }
        } else {
            // Si está jugando y se desconecta por error de red, solo lo marcamos offline
            player.offline = true;
            io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `⚠️ ${player.name} perdió la conexión.`, character: '📡' });
            if (room.turnIndex === idx) nextTurn(roomId);
            io.to(roomId).emit('update_game', sanitizeRoom(room));
        }
        changed = true;
    }
    return changed;
};

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.emit('update_public_rooms', Object.values(rooms).map(r => ({ id: r.id, host: r.players[0]?.name || 'Desc', players: r.players.length, max: r.maxPlayers, state: r.state })));

    socket.on('join_room', ({ roomId, name, activeEffect }) => {
        let room = rooms[roomId]; if (!room) return socket.emit('error_msg', '⚠️ La mesa no existe.');
        const existingPlayer = room.players.find(p => p.name === name);

        // MECANISMO DE RECONEXIÓN
        if (existingPlayer) {
            existingPlayer.id = socket.id; existingPlayer.offline = false;
            socket.join(roomId); socket.emit('room_joined', { roomId }); 
            io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `✅ ${name} se ha reconectado.`, character: '🔌' });
            if(room.state === 'playing') socket.emit('update_hand', existingPlayer.hand); 
            return io.to(roomId).emit('update_game', sanitizeRoom(room));
        }
        
        if (room.state === 'playing' || room.state === 'finished') {
            room.spectators.push({ id: socket.id, name, character: '👀', lastMsg: '', msgCount: 0, mutedUntil: 0 }); socket.join(roomId); socket.emit('room_joined', { roomId }); broadcastPublicRooms(); return io.to(roomId).emit('update_game', sanitizeRoom(room)); 
        }

        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '⚠️ Mesa llena.');
        room.players.push({ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], offline: false, lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true, activeEffect: activeEffect || '', isBot: false });
        socket.join(roomId); socket.emit('room_joined', { roomId }); io.to(roomId).emit('update_lobby', sanitizeRoom(room)); broadcastPublicRooms();
    });

    socket.on('create_room', ({ name, activeEffect }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = { id: roomId, players: [{ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], offline: false, lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true, activeEffect: activeEffect || '', isBot: false }], spectators: [], deck: [], discardPile: [], turnIndex: 0, state: 'waiting', phase: 'draw', exposedGroups: [], history: [], maxPlayers: 5, jokerCount: 2, turnTime: 30, startingPlayerId: socket.id, turnTimer: null, timerExpires: 0 };
        socket.join(roomId); socket.emit('room_joined', { roomId }); io.to(roomId).emit('update_lobby', sanitizeRoom(rooms[roomId])); broadcastPublicRooms();
    });

    socket.on('add_bot', ({ roomId, level }) => {
        const room = rooms[roomId]; if (!room || room.players[0].id !== socket.id) return;
        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '⚠️ Mesa llena, no caben más bots.');
        
        let colors = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6'];
        let color = colors[parseInt(level) - 1] || '#fff';
        let botName = `Bot Lvl ${level}`;
        
        room.players.push({ id: 'bot_'+Math.random().toString(36).substring(7), isBot: true, difficulty: parseInt(level), name: botName, character: '👾', ready: true, surrendered: false, hand: [], offline: false, inLobby: true, activeEffect: `color: ${color}; text-shadow: 0 0 5px ${color};` });
        io.to(roomId).emit('update_lobby', sanitizeRoom(room)); broadcastPublicRooms();
    });

    socket.on('change_settings', ({ roomId, maxPlayers, jokerCount, startingPlayerId, turnTime }) => {
        const room = rooms[roomId]; if (!room || room.players[0].id !== socket.id) return;
        room.maxPlayers = parseInt(maxPlayers); room.jokerCount = parseInt(jokerCount); room.startingPlayerId = startingPlayerId; room.turnTime = parseInt(turnTime);
        io.to(roomId).emit('update_lobby', sanitizeRoom(room)); broadcastPublicRooms();
    });

    socket.on('select_character', ({ roomId, character }) => {
        const room = rooms[roomId]; if (!room) return;
        if (room.players.some(p => p.character === character && !p.isBot)) return socket.emit('error_msg', '⚠️ Ocupado.');
        const player = room.players.find(p => p.id === socket.id);
        if (player) { player.character = character; io.to(roomId).emit('update_lobby', sanitizeRoom(room)); }
    });

    socket.on('toggle_ready', (roomId) => {
        const room = rooms[roomId]; if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) { if (!player.character) return socket.emit('error_msg', '⚠️ Selecciona un personaje.'); player.ready = !player.ready; io.to(roomId).emit('update_lobby', sanitizeRoom(room)); }
    });

    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players[0].id !== socket.id || !room.players.every(p => p.ready && p.inLobby) || room.players.length < 2) return socket.emit('error_msg', '⚠️ Todos listos para iniciar.');

        room.state = 'playing'; room.deck = createDeck(room.jokerCount); room.discardPile = []; room.exposedGroups = [];
        room.turnIndex = room.players.findIndex(p => p.id === room.startingPlayerId); if (room.turnIndex === -1) room.turnIndex = 0;

        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); p.surrendered = false; p.inLobby = false; });
        room.players[room.turnIndex].hand.push(room.deck.pop()); 
        
        room.players.filter(p=>!p.isBot).forEach(p => { io.to(p.id).emit('update_hand', p.hand); });
        room.phase = 'discard'; startTurnTimer(roomId); io.to(roomId).emit('update_game', sanitizeRoom(room)); broadcastPublicRooms();
    });

    // CORRECCIÓN SURRENDER: No elimina las cartas de la mano
    socket.on('surrender_hand', (roomId) => {
        const room = rooms[roomId]; if (!room || room.state !== 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.surrendered) {
            player.surrendered = true; // Se mantiene la mano intacta para la tabla de resultados
            let activePlayers = room.players.filter(p => !p.surrendered && !p.offline);
            if (activePlayers.length <= 1) { forceGameOver(roomId, null); } else { if (room.players[room.turnIndex].id === socket.id) nextTurn(roomId); else io.to(roomId).emit('update_game', sanitizeRoom(room)); }
        }
    });

    socket.on('return_individual_lobby', (roomId) => {
        const room = rooms[roomId]; if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.inLobby = true; socket.emit('force_to_lobby'); 
            if (room.players.filter(p=>!p.isBot).every(p => p.inLobby)) { room.state = 'waiting'; room.deck = []; room.discardPile = []; room.exposedGroups = []; room.players.forEach(p => { p.hand = []; p.ready = p.isBot?true:false; p.surrendered = false; }); }
            io.to(roomId).emit('update_lobby', sanitizeRoom(room)); broadcastPublicRooms();
        }
    });

    socket.on('draw_card', ({ roomId, source }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

        if (source === 'deck') {
            if (room.deck.length === 0) {
                if (room.discardPile.length > 1) { const topDiscard = room.discardPile.pop(); room.deck = room.discardPile.sort(() => Math.random() - 0.5); room.discardPile = [topDiscard]; } else { return socket.emit('error_msg', '⚠️ No hay cartas.'); }
            }
            let card = room.deck.pop();
            if (card) { player.hand.push(card); room.phase = 'discard'; startTurnTimer(roomId); socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room)); }
        }
    });

    socket.on('pick_discard_with_meld', ({ roomId, selectedIds, jokerRank, jokerSuit }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

        let topCard = room.discardPile[room.discardPile.length - 1]; if (!topCard) return;
        let cardsForMeld = player.hand.filter(c => selectedIds.includes(c.id));
        
        let tempCards = cardsForMeld.map(c => ({...c}));
        tempCards.forEach(c => {
            if (c.id.includes('Joker') && jokerRank && jokerSuit) { c.rank = jokerRank; c.suit = jokerSuit; c.value = getCardValue(jokerRank); }
        });
        tempCards.push(topCard);

        if (isValidMelding(tempCards)) {
            room.discardPile.pop();
            player.hand = player.hand.filter(c => !selectedIds.includes(c.id));
            cardsForMeld.forEach(c => {
                if (c.id.includes('Joker') && jokerRank && jokerSuit) { c.rank = jokerRank; c.suit = jokerSuit; c.value = getCardValue(jokerRank); }
            });
            cardsForMeld.push(topCard);
            room.exposedGroups.push({ id: 'g_' + Math.random().toString(36).substr(2, 9), ownerName: player.name, cards: cardsForMeld });
            room.phase = 'discard'; startTurnTimer(roomId); socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
        } else { socket.emit('error_msg', '⚠️ Combinación Inválida. Revisa tu grupo.'); }
    });

    socket.on('discard', ({ roomId, cardId }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        if (cardIdx > -1) { const card = player.hand.splice(cardIdx, 1)[0]; room.discardPile.push(card); socket.emit('update_hand', player.hand); nextTurn(roomId); }
    });

    socket.on('plug_card', ({ roomId, groupId, cardId }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const group = room.exposedGroups.find(g => g.id === groupId);
        if (group && group.cards.length >= 4) return socket.emit('error_msg', '⚠️ Grupo lleno (Máx 4).');

        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        if (group && cardIdx > -1) {
            let card = player.hand[cardIdx];
            if (canPlugIn(group.cards, card)) { player.hand.splice(cardIdx, 1); group.cards.push(card); socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room)); } 
            else { socket.emit('error_msg', '⚠️ No engancha aquí.'); }
        }
    });

    socket.on('unplug_card', ({ roomId, groupId, cardId }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const groupIdx = room.exposedGroups.findIndex(g => g.id === groupId); if (groupIdx === -1) return;
        const group = room.exposedGroups[groupIdx];

        const cardIdx = group.cards.findIndex(c => c.id === cardId);
        if (cardIdx > -1) {
            const card = group.cards.splice(cardIdx, 1)[0]; player.hand.push(card);
            if (group.cards.length < 3 || !isValidMelding(group.cards)) { player.hand.push(...group.cards); room.exposedGroups.splice(groupIdx, 1); }
            socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
        }
    });

    socket.on('reorder_hand', ({ roomId, newOrder }) => {
        const room = rooms[roomId]; if (!room || room.state !== 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) { player.hand.sort((a, b) => { let idxA = newOrder.indexOf(a.id); let idxB = newOrder.indexOf(b.id); return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB); }); }
    });

    socket.on('knock', (roomId) => {
        const room = rooms[roomId]; const knocker = room.players.find(p => p.id === socket.id);
        if (!room || !knocker || room.players[room.turnIndex].id !== socket.id) return;
        if (room.phase !== 'draw') return socket.emit('error_msg', '⚠️ Golpea al inicio de tu turno, ANTES de robar.');
        if (knocker.hand.length === 8) return socket.emit('error_msg', '⚠️ Tienes 8 cartas. Termina tu descarte.');

        let hasExposed = room.exposedGroups.some(g => g.ownerName === knocker.name);
        let hasInHand = hasValidGroup(knocker.hand);
        if (!hasExposed && !hasInHand) return socket.emit('error_msg', '⚠️ Debes tener al menos un juego válido.');
        forceGameOver(roomId, socket.id); 
    });

    socket.on('send_chat', ({ roomId, msg }) => {
        const room = rooms[roomId]; if (!room) return;
        let player = room.players.find(p => p.id === socket.id) || room.spectators.find(s => s.id === socket.id);
        if (!player) return; io.to(roomId).emit('chat_msg', { sender: player.name, msg, character: player.character || '👀' });
    });

    socket.on('taunt_card', ({ roomId, cardId }) => {
        const room = rooms[roomId]; const player = room.players.find(p => p.id === socket.id); if (!room || !player) return;
        const card = player.hand.find(c => c.id === cardId);
        if (card) io.to(roomId).emit('show_taunt', { playerId: socket.id, card });
    });

    socket.on('vote_kick_player', ({ roomId, targetName }) => {
        const room = rooms[roomId]; if(!room) return;
        if (room.players[0].id !== socket.id) return socket.emit('error_msg', 'Solo el creador puede expulsar.');
        handleLeaveRoom({ id: 'dummy' }, roomId, true); // Dummy implementation, requires full target removal logic.
        io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `Expulsión solicitada. (BETA)`, character: '🚨' });
    });

    socket.on('leave_room', (roomId) => { if (handleLeaveRoom(socket, roomId, true)) { socket.leave(roomId); socket.emit('left_room'); broadcastPublicRooms(); } });
    socket.on('disconnect', () => { 
        for (let roomId in rooms) { handleLeaveRoom(socket, roomId, false); } broadcastPublicRooms(); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
