const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.use(express.static(__dirname));

const rooms = {};
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// VALORES ACTUALIZADOS: As, 10, J, Q, K valen 10 puntos
const getCardValue = (rank) => {
    if (['A', '10', 'J', 'Q', 'K'].includes(rank)) return 10;
    if (rank === 'Joker') return 0;
    return parseInt(rank);
};

const createDeck = (jokerCount) => {
    let deck = [];
    suits.forEach(suit => {
        ranks.forEach(rank => {
            deck.push({ suit, rank, value: getCardValue(rank), id: `${rank}_${suit}` });
        });
    });
    for (let i = 1; i <= jokerCount; i++) {
        deck.push({ suit: 'none', rank: 'Joker', value: 0, id: `Joker_${i}_${Date.now()}` });
    }
    return deck.sort(() => Math.random() - 0.5);
};

// VALIDADOR INTELIGENTE (Incluye grupos puros de Jokers)
const isValidMelding = (cards) => {
    if (cards.length < 3) return false;
    let jokers = cards.filter(c => c.rank === 'Joker').length;
    let normals = cards.filter(c => c.rank !== 'Joker');
    
    // PERMITE GRUPOS PUROS DE JOKERS
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
    // Si quedan jokers sueltos, anulan automáticamente la carta suelta de mayor peso
    normals.forEach(card => {
        if (jokers > 0) { jokers--; } else { points += card.value; }
    });
    return points;
};

// MOTOR DE OPTIMIZACIÓN DE PUNTOS
const getOptimalFinalScore = (hand, exposedGroups) => {
    let baseNormals = hand.filter(c => c.rank !== 'Joker');
    let totalJokers = hand.filter(c => c.rank === 'Joker').length;

    function evaluate(cards, jokers, tableGroups) {
        let minScore = calculatePoints([...cards, ...Array(jokers).fill({rank:'Joker', value:0})]);
        
        // Evaluar armar grupos de Jokers puros
        if (jokers >= 3) minScore = Math.min(minScore, evaluate(cards, jokers - 3, tableGroups));
        if (jokers >= 4) minScore = Math.min(minScore, evaluate(cards, jokers - 4, tableGroups));

        if (cards.length >= 1) {
            for (let i = 0; i < cards.length; i++) {
                if (jokers >= 2) {
                    if (isValidMelding([cards[i], {rank:'Joker'}, {rank:'Joker'}])) {
                        let rem = cards.filter((_, idx) => idx !== i);
                        minScore = Math.min(minScore, evaluate(rem, jokers - 2, tableGroups));
                    }
                }
                for (let j = i + 1; j < cards.length; j++) {
                    if (jokers >= 1) {
                        if (isValidMelding([cards[i], cards[j], {rank:'Joker'}])) {
                            let rem = cards.filter((_, idx) => idx !== i && idx !== j);
                            minScore = Math.min(minScore, evaluate(rem, jokers - 1, tableGroups));
                        }
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
                if (isValidMelding([...targetGroup.cards, cards[i]]) && targetGroup.cards.length < 4) {
                    let nextGroups = tableGroups.map((tg, idx) => {
                        if (idx === g) return { ...tg, cards: [...tg.cards, cards[i]] };
                        return tg;
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

const hasValidGroup = (hand) => {
    let initialPoints = calculatePoints(hand);
    let optimalPoints = getOptimalFinalScore(hand, []);
    return optimalPoints < initialPoints;
};

const canPlugIn = (group, card) => { return isValidMelding([...group, card]); };

const sanitizeRoom = (room) => {
    return {
        id: room.id, players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, character: p.character, ready: p.ready, surrendered: p.surrendered, isBot: p.isBot })),
        topDiscard: room.discardPile[room.discardPile.length - 1] || null, turnId: room.players[room.turnIndex]?.id, deckCount: room.deck.length,
        phase: room.phase, exposedGroups: room.exposedGroups, maxPlayers: room.maxPlayers, jokerCount: room.jokerCount, state: room.state, startingPlayerId: room.startingPlayerId, kickVotes: room.kickVotes, botDifficulty: room.botDifficulty
    };
};

const nextTurn = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    let attempts = 0;
    do {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        attempts++;
    } while (room.players[room.turnIndex].surrendered && attempts < room.players.length);
    room.phase = 'draw'; room.kickVotes = []; 
    io.to(roomId).emit('update_game', sanitizeRoom(room));
};

const forceGameOver = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const scores = room.players.map(p => {
        let finalScore = p.surrendered ? getOptimalFinalScore(p.hand, room.exposedGroups) + 20 : getOptimalFinalScore(p.hand, room.exposedGroups);
        return { name: p.name, score: finalScore, character: p.character, finalHand: p.hand };
    });
    scores.sort((a, b) => a.score - b.score);
    io.to(roomId).emit('game_over', { scores, knocker: 'Mesa Cerrada', winner: scores[0].name, wasVolteado: false });
};

io.on('connection', (socket) => {
    
    socket.on('join_room', ({ roomId, name }) => {
        let room = rooms[roomId];
        if (!room) return socket.emit('error_msg', '⚠️ El código de sala no existe.');

        const existingPlayer = room.players.find(p => p.name === name);
        if (existingPlayer && room.state === 'waiting') return socket.emit('error_msg', '⚠️ Ese nickname ya está en uso.');

        if (existingPlayer && room.state === 'playing') {
            existingPlayer.id = socket.id;
            socket.join(roomId);
            socket.emit('room_joined', { roomId, isHost: (room.players[0].name === name) });
            socket.emit('update_hand', existingPlayer.hand);
            return io.to(roomId).emit('update_game', sanitizeRoom(room));
        }

        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '⚠️ Sala llena.');

        room.players.push({ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], isBot: false });
        socket.join(roomId);
        socket.emit('room_joined', { roomId, isHost: false });
        io.to(roomId).emit('update_lobby', sanitizeRoom(room));
    });

    socket.on('create_room', ({ name }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId, players: [{ id: socket.id, name, character: null, ready: false, surrendered: false, hand: [], isBot: false }],
            deck: [], discardPile: [], turnIndex: 0, state: 'waiting', phase: 'draw', exposedGroups: [],
            maxPlayers: 5, jokerCount: 2, startingPlayerId: socket.id, kickVotes: [], botDifficulty: null
        };
        socket.join(roomId); socket.emit('room_joined', { roomId, isHost: true });
        io.to(roomId).emit('update_lobby', sanitizeRoom(rooms[roomId]));
    });

    socket.on('change_settings', ({ roomId, maxPlayers, jokerCount, startingPlayerId }) => {
        const room = rooms[roomId];
        if (!room || room.players[0].id !== socket.id) return;
        room.maxPlayers = parseInt(maxPlayers); room.jokerCount = parseInt(jokerCount); room.startingPlayerId = startingPlayerId;
        io.to(roomId).emit('update_lobby', sanitizeRoom(room));
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            let room = rooms[roomId];
            let idx = room.players.findIndex(p => p.id === socket.id);
            if (idx > -1) {
                if (room.state === 'waiting') {
                    room.players.splice(idx, 1);
                    if (room.players.length === 0) delete rooms[roomId];
                    else io.to(roomId).emit('update_lobby', sanitizeRoom(room));
                }
                break;
            }
        }
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
            if (!player.character) return socket.emit('error_msg', '⚠️ Selecciona un personaje primero.');
            player.ready = !player.ready; io.to(roomId).emit('update_lobby', sanitizeRoom(room));
        }
    });

    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.players.every(p => p.ready) || room.players.length < 2) return;

        room.state = 'playing'; room.deck = createDeck(room.jokerCount);
        room.discardPile = []; room.exposedGroups = []; room.kickVotes = [];

        room.turnIndex = room.players.findIndex(p => p.id === room.startingPlayerId);
        if (room.turnIndex === -1) room.turnIndex = 0;

        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); p.surrendered = false; });
        room.players[room.turnIndex].hand.push(room.deck.pop()); // Primer jugador arranca con 8
        
        room.players.forEach(p => { if(!p.isBot) io.to(p.id).emit('update_hand', p.hand); });
        room.phase = 'discard'; 
        io.to(roomId).emit('update_game', sanitizeRoom(room));
    });

    socket.on('surrender_hand', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.surrendered) {
            player.surrendered = true; room.discardPile.push(...player.hand); player.hand = [];
            let activePlayers = room.players.filter(p => !p.surrendered);
            if (activePlayers.length <= 1) { forceGameOver(roomId); } 
            else { if (room.players[room.turnIndex].id === socket.id) nextTurn(roomId); else io.to(roomId).emit('update_game', sanitizeRoom(room)); }
        }
    });

    socket.on('vote_kick_player', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'playing') return;
        const activePlayer = room.players[room.turnIndex];
        if (!activePlayer) return;

        if (room.kickVotes.includes(socket.id)) return socket.emit('error_msg', '⚠️ Ya votaste.');
        room.kickVotes.push(socket.id);

        const requiredVotes = room.players.length - 1; 
        if (room.kickVotes.length >= requiredVotes) {
            io.to(roomId).emit('error_msg', `🚨 Expulsado: ${activePlayer.name}`);
            room.players.splice(room.turnIndex, 1); room.kickVotes = [];
            if (room.players.length < 2) {
                room.state = 'waiting'; io.to(roomId).emit('returned_to_lobby', sanitizeRoom(room));
            } else {
                room.turnIndex = room.turnIndex % room.players.length; room.phase = 'draw'; io.to(roomId).emit('update_game', sanitizeRoom(room));
            }
        } else { io.to(roomId).emit('update_game', sanitizeRoom(room)); }
    });

    socket.on('request_back_to_lobby', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        room.state = 'waiting'; room.deck = []; room.discardPile = []; room.exposedGroups = [];
        room.players.forEach(p => { p.hand = []; p.ready = false; p.surrendered = false; });
        io.to(roomId).emit('returned_to_lobby', sanitizeRoom(room));
    });

    socket.on('draw_card', ({ roomId, source }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!room || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

        if (source === 'deck') {
            if (room.deck.length === 0) {
                if (room.discardPile.length > 1) {
                    const topDiscard = room.discardPile.pop();
                    const cardsToReshuffle = room.discardPile;
                    room.deck = cardsToReshuffle.sort(() => Math.random() - 0.5); room.discardPile = [topDiscard];
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
        if (!room || room.players[room.turnIndex].id !== socket.id || room.phase !== 'draw') return;

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
        if (!room || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

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
        if (!room || room.players[room.turnIndex].id !== socket.id || room.phase !== 'discard') return;

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
        if (!room || room.players[room.turnIndex].id !== socket.id) return;

        // REGLA ESTRICTA: Quien tenga 8 cartas (el que inicia) no puede golpear hasta botar una.
        if (knocker.hand.length === 8) {
            return socket.emit('error_msg', '⚠️ No puedes golpear con 8 cartas. Primero debes descartar tu carta a la mesa.');
        }

        let hasExposed = room.exposedGroups.some(g => g.ownerName === knocker.name);
        let hasInHand = hasValidGroup(knocker.hand);
        
        if (!hasExposed && !hasInHand) return socket.emit('error_msg', '⚠️ No puedes golpear sin tener al menos un juego válido.');

        const scores = room.players.map(p => {
            let finalScore = p.surrendered ? getOptimalFinalScore(p.hand, room.exposedGroups) + 20 : getOptimalFinalScore(p.hand, room.exposedGroups);
            return { name: p.name, score: finalScore, character: p.character, finalHand: p.hand };
        });
        scores.sort((a, b) => a.score - b.score);
        const winner = scores[0];
        io.to(roomId).emit('game_over', { scores, knocker: knocker.name, winner: winner.name, wasVolteado: winner.name !== knocker.name });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
