const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

// Usamos la variable de Render
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/saloon_golpeado';

mongoose.connect(MONGO_URI)
    .then(() => console.log('📦 Base de Datos Conectada'))
    .catch(err => console.error('⚠️ ERROR DE CONEXIÓN BD:', err));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    victories: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// Rutas API con manejo de errores
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'El nombre ya está en uso' });
        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ username, password: hashedPassword }).save();
        res.status(201).json({ message: 'Cuenta creada' });
    } catch (e) { res.status(500).json({ error: 'Error BD: ' + e.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Credenciales inválidas' });
        res.status(200).json({ user: { username: user.username, points: user.points, victories: user.victories } });
    } catch (e) { res.status(500).json({ error: 'Error BD: ' + e.message }); }
});

// ... (Aquí debe ir todo tu código anterior de Socket.io y lógica de juego) ...
// server.listen(process.env.PORT || 3000, ...);
