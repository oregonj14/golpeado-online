const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // Usamos la versión segura para Render

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.use(express.static(__dirname));

// CONEXIÓN A MONGODB EN LA NUBE (O Local si lo pruebas en tu PC)
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/saloon_golpeado';
mongoose.connect(MONGO_URI)
    .then(() => console.log('📦 Base de Datos MongoDB Conectada con éxito'))
    .catch(err => console.warn('⚠️ MongoDB no detectado. El juego funcionará en RAM temporal.'));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    victories: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// RUTAS API PARA LOGIN Y REGISTRO
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'El Nickname ya está en uso' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'Cuenta creada con éxito', user: { username: newUser.username, points: newUser.points, victories: newUser.victories } });
    } catch (error) { 
        console.error("🔥 ERROR EN BD (Registro):", error); // <-- ESTO NOS DIRÁ EL PROBLEMA REAL
        res.status(500).json({ error: 'Error del servidor BD. Revisa los Logs de Render.' }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Contraseña incorrecta' });
        res.status(200).json({ message: 'Login exitoso', user: { username: user.username, points: user.points, victories: user.victories } });
    } catch (error) { 
        console.error("🔥 ERROR EN BD (Login):", error);
        res.status(500).json({ error: 'Error del servidor BD. Revisa los Logs de Render.' }); 
    }
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
    
    room.turnTimer = setTimeout(() => {
        try { executeAutoPlay(roomId); } catch (e) { console.error("Error AutoPlay:", e); }
    }, ms);
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

    io.to(roomId).emit('chat_msg', { sender: 'Sistema', msg: `⏳ Tiempo agotado. Se auto-descartó una carta de ${player.name}.`, character: '🤖' });
    io.to(player.id).emit('update_hand', player.hand);
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

    let knockerName = 'Mesa Cerrada';
    let wasVolteado = false;

    if (knockerId) {
        let knockerIndex = room.players.findIndex(p => p.id === knockerId);
        if (knockerIndex > -1) {
            knockerName = room.players[knockerIndex].name;
            scores.forEach(s => {
                let pIndex = room.players.findIndex(p => p.id === s.id);
                s.turnDiff = (pIndex - knockerIndex + room.players.length) % room.players.length;
            });
        }
    }

    scores.sort((a, b) => {
        if (a.score === b.score) return a.turnDiff - b.turnDiff;
        return a.score - b.score;
    });

    const winner = scores[0];
    if (knockerId && winner.id !== knockerId) wasVolteado = true;

    room.history.push({
        winner: winner.name, score: winner.score, hand: winner.finalHand, wasVolteado: wasVolteado
    });

    try {
        if (mongoose.connection.readyState === 1) {
            // Esto fallará silenciosamente (sin crashear) si el ganador es un usuario invitado que no existe en la BD.
            await User.findOneAndUpdate({ username: winner.name }, { $inc: { victories: 1, points: 50 } });
        }
    } catch (error) { console.error("Error BD Recompensas:", error); }

    io.to(roomId).emit('game_over', { scores, knocker: knockerName, winner: winner.name, wasVolteado });
    io.to(roomId).emit('update_lobby', sanitizeRoom(room)); 
};

const handleLeaveRoom = (socket, roomId) => {
    let room = rooms[roomId];
    if (!room) return false;
    
    let changed = false;
    let specIdx = room.spectators.findIndex(s => s.id === socket.id);
    if (specIdx > -1) { room.spectators.splice(specIdx, 1); changed = true; }

    let idx = room.players.findIndex(p => p.id === socket.id);
    if (idx > -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
            clearTimeout(room.turnTimer);
            delete rooms[roomId];
        } else {
            if (room.state === 'playing') {
                if (room.players.length < 2) {
                    clearTimeout(room.turnTimer);
                    room.state = 'waiting';
                    room.players.forEach(p => p.inLobby = true);
                    io.to(roomId).emit('force_to_lobby');
                    io.to(roomId).emit('update_lobby', sanitizeRoom(room));
                } else {
                    if (room.turnIndex === idx) {
                        room.turnIndex = room.turnIndex % room.players.length;
                        room.phase = 'draw';
                        startTurnTimer(roomId);
                    } else if (room.turnIndex > idx) {
                        room.turnIndex--;
                    }
                    io.to(roomId).emit('update_game', sanitizeRoom(room));
                }
            } else {
                if (room.state === 'finished' && room.players.every(p => p.inLobby)) {
                    room.state = 'waiting';
                    room.deck = []; room.discardPile = []; room.exposedGroups = [];
                    room.players.forEach(p => { p.hand = []; p.ready = false; p.surrendered = false; });
                }
                io.to(roomId).emit('update_lobby', sanitizeRoom(room));
            }
        }
        changed = true;
    }
    return changed;
};

io.on('connection', (socket) => {
    
    socket.emit('update_public_rooms', Object.values(rooms).map(r => ({ id: r.id, host: r.players[0]?.name || 'Desc', players: r.players.length, max: r.maxPlayers, state: r.state })));

    socket.on('join_room', ({ roomId, name }) => {
        try {
            let room = rooms[roomId];
            if (!room) return socket.emit('error_msg', '⚠️ El código de sala no existe.');
            
            const existingPlayer = room.players.find(p => p.name === name);
            const existingSpectator = room.spectators.find(s => s.name === name);

            if (room.state === 'playing' || room.state === 'finished') {
                if (existingPlayer) {
                    existingPlayer.id = socket.id; socket.join(roomId);
                    socket.emit('room_joined', { roomId });
                    if(room.state === 'playing') socket.emit('update_hand', existingPlayer.hand); 
                    return io.to(roomId).emit('update_game', sanitizeRoom(room));
                } else if (existingSpectator) {
                    existingSpectator.id = socket.id; socket.join(roomId);
                    socket.emit('room_joined', { roomId });
                    return io.to(roomId).emit('update_game', sanitizeRoom(room));
                } else {
                    room.spectators.push({ id: socket.id, name, character: '👀', lastMsg: '', msgCount: 0, mutedUntil: 0 });
                    socket.join(roomId);
                    socket.emit('room_joined', { roomId });
                    broadcastPublicRooms();
                    return io.to(roomId).emit('update_game', sanitizeRoom(room));
                }
            }

            if (existingPlayer) return socket.emit('error_msg', '⚠️ Ese nickname ya está en uso en esta mesa.');
            if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '⚠️ Sala llena.');

            room.players.push({ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true });
            socket.join(roomId); socket.emit('room_joined', { roomId }); 
            io.to(roomId).emit('update_lobby', sanitizeRoom(room));
            broadcastPublicRooms();
        } catch(e) { console.error(e); }
    });

    socket.on('create_room', ({ name }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId, 
            players: [{ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true }],
            spectators: [], deck: [], discardPile: [], turnIndex: 0, state: 'waiting', phase: 'draw', exposedGroups: [], history: [],
            maxPlayers: 5, jokerCount: 2, turnTime: 30, startingPlayerId: socket.id, kickVotes: [], turnTimer: null, timerExpires: 0
        };
        socket.join(roomId); socket.emit('room_joined', { roomId }); 
        io.to(roomId).emit('update_lobby', sanitizeRoom(rooms[roomId]));
        broadcastPublicRooms();
    });

    socket.on('change_settings', ({ roomId, maxPlayers, jokerCount, startingPlayerId, turnTime }) => {
        const room = rooms[roomId];
        if (!room || room.players[0].id !== socket.id) return;
        room.maxPlayers = parseInt(maxPlayers); room.jokerCount = parseInt(jokerCount); room.startingPlayerId = startingPlayerId; room.turnTime = parseInt(turnTime);
        io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        broadcastPublicRooms();
    });

    socket.on('leave_room', (roomId) => {
        if (handleLeaveRoom(socket, roomId)) {
            socket.leave(roomId);
            socket.emit('left_room');
            broadcastPublicRooms();
        }
    });

    socket.on('disconnect', () => {
        let changed = false;
        for (let roomId in rooms) {
            if (handleLeaveRoom(socket, roomId)) { changed = true; }
        }
        if(changed) broadcastPublicRooms();
    });

    socket.on('select_character', ({ roomId, character }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.players.some(p => p.character === character)) return socket.emit('error_msg', '⚠️ Personaje ocupado.');
        const player = room.players.find(p => p.id === socket.id);
        if (player) { player.character = character; io.to(roomId).emit('update_lobby', sanitizeRoom(room)); }
    });

    socket.on('toggle_ready', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            if (!player.character) return socket.emit('error_msg', '⚠️ Selecciona un sombrero primero.');
            player.ready = !player.ready; io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        }
    });

    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players[0].id !== socket.id || !room.players.every(p => p.ready && p.inLobby) || room.players.length < 2) {
            return socket.emit('error_msg', '⚠️ Todos deben estar listos y en el lobby para iniciar.');
        }

        room.state = 'playing'; room.deck = createDeck(room.jokerCount);
        room.discardPile = []; room.exposedGroups = []; room.kickVotes = [];

        room.turnIndex = room.players.findIndex(p => p.id === room.startingPlayerId);
        if (room.turnIndex === -1) room.turnIndex = 0;

        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); p.surrendered = false; p.lastMsg = ''; p.msgCount = 0; p.mutedUntil = 0; p.inLobby = false; });
        room.players[room.turnIndex].hand.push(room.deck.pop()); 
        
        room.players.forEach(p => { io.to(p.id).emit('update_hand', p.hand); });
        room.phase = 'discard'; 
        startTurnTimer(roomId);
        io.to(roomId).emit('update_game', sanitizeRoom(room));
        broadcastPublicRooms();
    });

    socket.on('surrender_hand', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.surrendered) {
            player.surrendered = true; room.discardPile.push(...player.hand); player.hand = [];
            let activePlayers = room.players.filter(p => !p.surrendered);
            if (activePlayers.length <= 1) { forceGameOver(roomId, null); } 
            else { if (room.players[room.turnIndex].id === socket.id) nextTurn(roomId); else io.to(roomId).emit('update_game', sanitizeRoom(room)); }
        }
    });

    socket.on('return_individual_lobby', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.inLobby = true;
            socket.emit('force_to_lobby'); 
            
            if (room.players.every(p => p.inLobby)) {
                room.state = 'waiting';
                while (room.spectators.length > 0 && room.players.length < room.maxPlayers) {
                    const spec = room.spectators.shift();
                    room.players.push({ id: spec.id, name: spec.name, character: null, ready: false, surrendered: false, hand: [], lastMsg: '', msgCount: 0, mutedUntil: 0, inLobby: true });
                }
                room.deck = []; room.discardPile = []; room.exposedGroups = [];
                room.players.forEach(p => { p.hand = []; p.ready = false; p.surrendered = false; });
            }
            
            io.to(roomId).emit('update_lobby', sanitizeRoom(room));
            broadcastPublicRooms();
        }
    });

    socket.on('draw_card', ({ roomId, source }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

        if (source === 'deck') {
            if (room.deck.length === 0) {
                if (room.discardPile.length > 1) {
                    const topDiscard = room.discardPile.pop();
                    room.deck = room.discardPile.sort(() => Math.random() - 0.5); room.discardPile = [topDiscard];
                } else { return socket.emit('error_msg', '⚠️ No hay más cartas.'); }
            }
            let card = room.deck.pop();
            if (card) {
                player.hand.push(card); room.phase = 'discard';
                socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
            }
        }
    });

    socket.on('pick_discard_with_meld', ({ roomId, selectedIds }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

        let topCard = room.discardPile[room.discardPile.length - 1];
        if (!topCard) return;

        let cardsForMeld = player.hand.filter(c => selectedIds.includes(c.id));
        cardsForMeld.push(topCard);

        if (cardsForMeld.length > 4) return socket.emit('error_msg', '⚠️ Un grupo no puede tener más de 4 cartas.');

        if (isValidMelding(cardsForMeld)) {
            room.discardPile.pop();
            player.hand = player.hand.filter(c => !selectedIds.includes(c.id));
            room.exposedGroups.push({ id: 'g_' + Math.random().toString(36).substr(2, 9), ownerName: player.name, cards: cardsForMeld });
            room.phase = 'discard';
            socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
        } else { socket.emit('error_msg', '⚠️ ¡Robo Inválido!'); }
    });

    socket.on('discard', ({ roomId, cardId }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        if (cardIdx > -1) {
            const card = player.hand.splice(cardIdx, 1)[0];
            room.discardPile.push(card);
            socket.emit('update_hand', player.hand); nextTurn(roomId);
        }
    });

    socket.on('plug_card', ({ roomId, groupId, cardId }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const group = room.exposedGroups.find(g => g.id === groupId);
        if (group && group.cards.length >= 4) return socket.emit('error_msg', '⚠️ El grupo ya tiene el máximo de 4 cartas.');

        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        if (group && cardIdx > -1) {
            let card = player.hand[cardIdx];
            if (canPlugIn(group.cards, card)) {
                player.hand.splice(cardIdx, 1); group.cards.push(card);
                socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
            } else { socket.emit('error_msg', '⚠️ No engancha aquí.'); }
        }
    });

    socket.on('unplug_card', ({ roomId, groupId, cardId }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

        const groupIdx = room.exposedGroups.findIndex(g => g.id === groupId);
        if (groupIdx === -1) return;
        const group = room.exposedGroups[groupIdx];

        const cardIdx = group.cards.findIndex(c => c.id === cardId);
        if (cardIdx > -1) {
            const card = group.cards.splice(cardIdx, 1)[0];
            player.hand.push(card);

            if (group.cards.length < 3 || !isValidMelding(group.cards)) {
                player.hand.push(...group.cards);
                room.exposedGroups.splice(groupIdx, 1);
            }
            socket.emit('update_hand', player.hand); io.to(roomId).emit('update_game', sanitizeRoom(room));
        }
    });

    socket.on('reorder_hand', ({ roomId, newOrder }) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.hand.sort((a, b) => {
                let idxA = newOrder.indexOf(a.id); let idxB = newOrder.indexOf(b.id);
                return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
            });
        }
    });

    socket.on('knock', (roomId) => {
        const room = rooms[roomId];
        const knocker = room.players.find(p => p.id === socket.id);
        if (!room || !knocker || room.players[room.turnIndex].id !== socket.id) return;

        if (room.phase !== 'draw') return socket.emit('error_msg', '⚠️ Solo puedes golpear al inicio de tu turno, ANTES de robar.');
        if (knocker.hand.length === 8) return socket.emit('error_msg', '⚠️ Tienes 8 cartas. Tu turno terminó mal, no puedes golpear ahora.');

        let hasExposed = room.exposedGroups.some(g => g.ownerName === knocker.name);
        let hasInHand = hasValidGroup(knocker.hand);
        
        if (!hasExposed && !hasInHand) return socket.emit('error_msg', '⚠️ No puedes golpear sin tener al menos un juego válido.');

        forceGameOver(roomId, socket.id); 
    });

    socket.on('send_chat', ({ roomId, msg }) => {
        const room = rooms[roomId];
        if (!room) return;
        let player = room.players.find(p => p.id === socket.id) || room.spectators.find(s => s.id === socket.id);
        if (!player) return;

        if (Date.now() < player.mutedUntil) {
            const left = Math.ceil((player.mutedUntil - Date.now()) / 1000);
            return socket.emit('error_msg', `🔇 Estás silenciado. Espera ${left}s.`);
        }

        if (player.lastMsg === msg) { player.msgCount++; } 
        else { player.lastMsg = msg; player.msgCount = 1; }

        if (player.msgCount >= 5) {
            player.mutedUntil = Date.now() + 10000; player.msgCount = 0;
            return socket.emit('error_msg', '🚫 Has sido silenciado por 10 segundos por hacer spam.');
        }

        io.to(roomId).emit('chat_msg', { sender: player.name, msg, character: player.character || '👀' });
    });

    socket.on('taunt_card', ({ roomId, cardId }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || !player) return;
        const card = player.hand.find(c => c.id === cardId);
        if (card) io.to(roomId).emit('show_taunt', { playerId: socket.id, card });
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
