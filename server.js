const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.use(express.static(__dirname));

// CONEXIÓN A MONGODB (Usa la variable de entorno URI o Localhost)
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/saloon_golpeado';
mongoose.connect(MONGO_URI)
    .then(() => console.log('📦 Base de Datos Conectada'))
    .catch(err => console.warn('⚠️ MongoDB no detectado. Funcionando en memoria RAM.'));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    victories: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// --- RUTAS API ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Usuario ocupado' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'Cuenta creada' });
    } catch (error) { res.status(500).json({ error: 'Error BD' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'No existe' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Clave incorrecta' });
        res.status(200).json({ user: { username: user.username, points: user.points, victories: user.victories } });
    } catch (error) { res.status(500).json({ error: 'Error BD' }); }
});

const rooms = {};
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const broadcastPublicRooms = () => {
    const publicRooms = Object.values(rooms).map(r => ({
        id: r.id, host: r.players[0]?.name || 'Desconocido', players: r.players.length, max: r.maxPlayers, state: r.state
    }));
    io.emit('update_public_rooms', publicRooms);
};

const getCardValue = (rank) => {
    if (['A', '10', 'J', 'Q', 'K'].includes(rank)) return 10;
    if (rank === 'Joker') return 0;
    return parseInt(rank);
};

const createDeck = (jokerCount) => {
    let deck = [];
    suits.forEach(suit => {
        ranks.forEach(rank => { deck.push({ suit, rank, value: getCardValue(rank), id: `${rank}_${suit}` }); });
    });
    for (let i = 1; i <= jokerCount; i++) {
        deck.push({ suit: 'none', rank: 'Joker', value: 0, id: `Joker_${i}_${Date.now()}` });
    }
    return deck.sort(() => Math.random() - 0.5);
};

const isValidMelding = (cards) => {
    if (cards.length < 3) return false;
    let jokers = cards.filter(c => c.rank === 'Joker').length;
    let normals = cards.filter(c => c.rank !== 'Joker');
    if (normals.length === 0) return true;

    let firstRank = normals[0].rank;
    if (normals.every(c => c.rank === firstRank)) {
        let uniqueSuits = new Set(normals.map(c => c.suit)).size;
        if (uniqueSuits + jokers === cards.length && cards.length <= 4) return true;
    }

    let suit = normals[0].suit;
    if (normals.every(c => c.suit === suit)) {
        let normalRanks = normals.map(c => c.rank);
        let valuesLow = normals.map(c => {
            if (c.rank === 'A') return 1;
            if (['J', 'Q', 'K'].includes(c.rank)) return c.rank === 'J' ? 11 : (c.rank === 'Q' ? 12 : 13);
            return parseInt(c.rank);
        }).sort((a, b) => a - b);
        let hasDuplicatesLow = new Set(valuesLow).size !== valuesLow.length;
        let gapsLow = 0;
        if (!hasDuplicatesLow) {
            for (let i = 0; i < valuesLow.length - 1; i++) { gapsLow += (valuesLow[i+1] - valuesLow[i] - 1); }
            if (gapsLow <= jokers) return true;
        }
        let valuesHigh = normals.map(c => {
            if (c.rank === 'A') return 14;
            if (['J', 'Q', 'K'].includes(c.rank)) return c.rank === 'J' ? 11 : (c.rank === 'Q' ? 12 : 13);
            return parseInt(c.rank);
        }).sort((a, b) => a - b);
        let hasDuplicatesHigh = new Set(valuesHigh).size !== valuesHigh.length;
        let gapsHigh = 0;
        if (!hasDuplicatesHigh) {
            for (let i = 0; i < valuesHigh.length - 1; i++) { gapsHigh += (valuesHigh[i+1] - valuesHigh[i] - 1); }
            if (gapsHigh <= jokers) return true;
        }
        let isSpecialWrap = normalRanks.every(r => ['K', 'A', '2'].includes(r)) && (normalRanks.includes('K') || normalRanks.includes('2'));
        if (isSpecialWrap && (normals.length + jokers >= 3)) return true;
    }
    return false;
};

const calculatePoints = (hand) => {
    let points = 0;
    let jokers = hand.filter(c => c.rank === 'Joker').length;
    let normals = hand.filter(c => c.rank !== 'Joker').sort((a, b) => b.value - a.value);
    normals.forEach(card => { if (jokers > 0) { jokers--; } else { points += card.value; } });
    return points;
};

const getOptimalFinalScore = (hand, exposedGroups) => {
    let baseNormals = hand.filter(c => c.rank !== 'Joker');
    let totalJokers = hand.filter(c => c.rank === 'Joker').length;

    function evaluate(cards, jokers, tableGroups) {
        let minScore = calculatePoints([...cards, ...Array(jokers).fill({rank:'Joker', value:0})]);
        if (jokers >= 3) minScore = Math.min(minScore, evaluate(cards, jokers - 3, tableGroups));
        if (jokers >= 4) minScore = Math.min(minScore, evaluate(cards, jokers - 4, tableGroups));
        if (cards.length >= 1) {
            for (let i = 0; i < cards.length; i++) {
                if (jokers >= 2 && isValidMelding([cards[i], {rank:'Joker'}, {rank:'Joker'}])) {
                    let rem = cards.filter((_, idx) => idx !== i);
                    minScore = Math.min(minScore, evaluate(rem, jokers - 2, tableGroups));
                }
                for (let j = i + 1; j < cards.length; j++) {
                    if (jokers >= 1 && isValidMelding([cards[i], cards[j], {rank:'Joker'}])) {
                        let rem = cards.filter((_, idx) => idx !== i && idx !== j);
                        minScore = Math.min(minScore, evaluate(rem, jokers - 1, tableGroups));
                    }
                    for (let k = j + 1; k < cards.length; k++) {
                        if (isValidMelding([cards[i], cards[j], cards[k]])) {
                            let rem = cards.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                            minScore = Math.min(minScore, evaluate(rem, jokers, tableGroups));
                        }
                        if (jokers >= 1 && isValidMelding([cards[i], cards[j], cards[k], {rank:'Joker'}])) {
                            let rem = cards.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                            minScore = Math.min(minScore, evaluate(rem, jokers - 1, tableGroups));
                        }
                    }
                }
            }
        }
        for (let i = 0; i < cards.length; i++) {
            for (let g = 0; g < tableGroups.length; g++) {
                let targetGroup = tableGroups[g];
                if (targetGroup.cards.length < 4 && isValidMelding([...targetGroup.cards, cards[i]])) {
                    let nextGroups = tableGroups.map((tg, idx) => {
                        if (idx === g) return { ...tg, cards: [...tg.cards, cards[i]] }; return tg;
                    });
                    let rem = cards.filter((_, idx) => idx !== i);
                    minScore = Math.min(minScore, evaluate(rem, jokers, nextGroups));
                }
            }
        }
        return minScore;
    }
    return evaluate(baseNormals, totalJokers, exposedGroups);
};

const hasValidGroup = (hand) => getOptimalFinalScore(hand, []) < calculatePoints(hand);
const canPlugIn = (group, card) => isValidMelding([...group, card]);

const sanitizeRoom = (room) => {
    return {
        id: room.id, 
        hostId: room.players[0]?.id, 
        players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, character: p.character, ready: p.ready, surrendered: p.surrendered, inLobby: p.inLobby })),
        spectators: room.spectators.map(s => ({ id: s.id, name: s.name })), 
        topDiscard: room.discardPile[room.discardPile.length - 1] || null, 
        turnId: room.players[room.turnIndex]?.id, 
        deckCount: room.deck.length,
        phase: room.phase, 
        exposedGroups: room.exposedGroups, 
        maxPlayers: room.maxPlayers, 
        jokerCount: room.jokerCount, 
        turnTime: room.turnTime, 
        state: room.state, 
        startingPlayerId: room.startingPlayerId, 
        history: room.history,
        timerExpires: room.timerExpires
    };
};

const startTurnTimer = (roomId) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    clearTimeout(room.turnTimer);
    const ms = room.turnTime * 1000;
    room.timerExpires = Date.now() + ms;
    room.turnTimer = setTimeout(() => executeAutoPlay(roomId), ms);
};

const executeAutoPlay = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[room.turnIndex];
    if (!player) return;

    if (room.phase === 'draw') {
        if (room.deck.length === 0 && room.discardPile.length > 1) {
            const topDiscard = room.discardPile.pop();
            room.deck = room.discardPile.sort(() => Math.random() - 0.5); room.discardPile = [topDiscard];
        }
        let card = room.deck.pop();
        if (card) player.hand.push(card);
    }

    let highestVal = -1; let candidates = [];
    player.hand.forEach(c => {
        if (c.rank === 'Joker') return;
        let v = getCardValue(c.rank);
        if (v > highestVal) { highestVal = v; candidates = [c]; } 
        else if (v === highestVal) { candidates.push(c); }
    });

    if (candidates.length === 0 && player.hand.length > 0) candidates = player.hand;

    if (candidates.length > 0) {
        const dropCard = candidates[Math.floor(Math.random() * candidates.length)];
        const dropIdx = player.hand.findIndex(c => c.id === dropCard.id);
        player.hand.splice(dropIdx, 1);
        room.discardPile.push(dropCard);
    }
    nextTurn(roomId);
};

const nextTurn = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    let attempts = 0;
    do {
        room.turnIndex = (room.turnIndex + 1) % room.players.length; attempts++;
    } while (room.players[room.turnIndex].surrendered && attempts < room.players.length);
    room.phase = 'draw'; room.kickVotes = []; 
    startTurnTimer(roomId);
    io.to(roomId).emit('update_game', sanitizeRoom(room));
};

const forceGameOver = async (roomId, knockerId) => {
    const room = rooms[roomId];
    if (!room) return;
    clearTimeout(room.turnTimer);
    room.state = 'finished';
    room.players.forEach(p => p.inLobby = false);

    const scores = room.players.map(p => {
        let finalScore = p.surrendered ? getOptimalFinalScore(p.hand, room.exposedGroups) + 20 : getOptimalFinalScore(p.hand, room.exposedGroups);
        return { id: p.id, name: p.name, score: finalScore, character: p.character, finalHand: p.hand, turnDiff: 0 };
    });

    let knockerIndex = room.players.findIndex(p => p.id === knockerId);
    scores.forEach(s => {
        let pIndex = room.players.findIndex(p => p.id === s.id);
        s.turnDiff = (pIndex - knockerIndex + room.players.length) % room.players.length;
    });

    scores.sort((a, b) => a.score - b.score || a.turnDiff - b.turnDiff);
    const winner = scores[0];
    let knockerName = knockerId ? room.players.find(p=>p.id===knockerId)?.name : 'Cerrada';
    let wasVolteado = (knockerId && winner.id !== knockerId);

    room.history.push({ winner: winner.name, score: winner.score, hand: winner.finalHand, wasVolteado });
    
    try { if (mongoose.connection.readyState === 1) await User.findOneAndUpdate({ username: winner.name }, { $inc: { victories: 1, points: 50 } }); } catch(e) {}
    
    io.to(roomId).emit('game_over', { scores, knocker: knockerName, winner: winner.name, wasVolteado });
    io.to(roomId).emit('update_lobby', sanitizeRoom(room));
};

const handleLeaveRoom = (socket, roomId) => {
    let room = rooms[roomId];
    if (!room) return false;
    let idx = room.players.findIndex(p => p.id === socket.id);
    if (idx > -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) { clearTimeout(room.turnTimer); delete rooms[roomId]; }
        else {
            if (room.state === 'playing') {
                if (room.players.length < 2) { clearTimeout(room.turnTimer); room.state = 'waiting'; io.to(roomId).emit('returned_to_lobby', sanitizeRoom(room)); }
                else { if (room.turnIndex === idx) { room.turnIndex %= room.players.length; room.phase = 'draw'; startTurnTimer(roomId); } 
                       else if (room.turnIndex > idx) room.turnIndex--;
                       io.to(roomId).emit('update_game', sanitizeRoom(room)); }
            } else io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        }
        return true;
    }
    return false;
};

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, name }) => {
        let room = rooms[roomId];
        if (!room) return socket.emit('error_msg', 'Sala no existe.');
        room.players.push({ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true });
        socket.join(roomId); socket.emit('room_joined', { roomId });
        io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        broadcastPublicRooms();
    });

    socket.on('create_room', ({ name }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = { id: roomId, players: [{ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], inLobby: true, lastMsg: '', msgCount: 0, mutedUntil: 0 }], spectators: [], deck: [], discardPile: [], turnIndex: 0, state: 'waiting', phase: 'draw', exposedGroups: [], history: [], maxPlayers: 5, jokerCount: 2, turnTime: 30, startingPlayerId: socket.id, kickVotes: [], turnTimer: null, timerExpires: 0 };
        socket.join(roomId); socket.emit('room_joined', { roomId }); 
        io.to(roomId).emit('update_lobby', sanitizeRoom(rooms[roomId]));
        broadcastPublicRooms();
    });

    socket.on('change_settings', ({ roomId, maxPlayers, jokerCount, startingPlayerId, turnTime }) => {
        const room = rooms[roomId];
        if (room && room.players[0].id === socket.id) {
            room.maxPlayers = parseInt(maxPlayers); room.jokerCount = parseInt(jokerCount); room.startingPlayerId = startingPlayerId; room.turnTime = parseInt(turnTime);
            io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        }
    });

    socket.on('leave_room', (roomId) => { if(handleLeaveRoom(socket, roomId)) { socket.leave(roomId); socket.emit('left_room'); broadcastPublicRooms(); } });
    socket.on('disconnect', () => { for (let roomId in rooms) { if(handleLeaveRoom(socket, roomId)) broadcastPublicRooms(); } });
    socket.on('toggle_ready', (roomId) => { const room = rooms[roomId]; const p = room?.players.find(p=>p.id===socket.id); if(p && p.character) { p.ready = !p.ready; io.to(roomId).emit('update_lobby', sanitizeRoom(room)); } });
    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players[0].id === socket.id && room.players.every(p => p.ready)) {
            room.state = 'playing'; room.deck = createDeck(room.jokerCount); room.players.forEach(p => { p.hand = room.deck.splice(0, 7); p.inLobby = false; });
            room.players[room.turnIndex].hand.push(room.deck.pop());
            startTurnTimer(roomId);
            io.to(roomId).emit('update_game', sanitizeRoom(room));
        }
    });

    socket.on('knock', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players[room.turnIndex].id === socket.id && room.phase === 'draw') forceGameOver(roomId, socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
