// Piano Sync System - Main Server
// Raspberry Pi マスター制御サーバー

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const cors = require('cors');

// GPIO制御 (Raspberry Pi用)
let GPIO;
try {
    GPIO = require('onoff').Gpio;
    console.log('✅ GPIO module loaded - hardware controls available');
} catch (error) {
    console.log('ℹ️  GPIO not available - software controls only');
    GPIO = null;
}

class PianoSyncServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        
        // サーバー設定
        this.port = process.env.PORT || 3000;
        this.wsPort = process.env.WS_PORT || 8080;
        
        // 接続管理
        this.connectedClients = new Map();
        this.currentSession = null;
        this.songs = [];
        this.autoStopTimer = null;
        
        // システム状態
        this.systemStatus = {
            startTime: Date.now(),
            isPlaying: false,
            currentSong: null,
            bpm: 120
        };

        // 無音検知用の独立変数
        this.lastNoteTime = null;
        this.silenceTimeout = null;
        this.maxSilenceDuration = 10000; // 10秒

        this.initialize();
    }

    async initialize() {
        try {
            // 楽曲データ読み込み
            await this.loadSongs();
            
            // Expressサーバー設定
            this.setupExpress();
            
            // WebSocketサーバー設定
            this.setupWebSocket();
            
            // GPIO設定（Raspberry Pi用）
            this.setupGPIO();
            
            // サーバー開始
            this.startServer();
            
        } catch (error) {
            console.error('❌ Server initialization failed:', error);
            process.exit(1);
        }
    }

    setupExpress() {
        // ミドルウェア設定
        this.app.use(compression());
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // 静的ファイル配信
        this.app.use(express.static(path.join(__dirname, 'public'), {
            maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
        }));

        // ルーティング設定
        this.setupRoutes();
    }

    setupRoutes() {
        // メイン制御パネル
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'control.html'));
        });

        // 右手（主旋律）ディスプレイ
        this.app.get('/melody', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'melody.html'));
        });

        // 左手（伴奏）ディスプレイ
        this.app.get('/accompaniment', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'accompaniment.html'));
        });

        // API エンドポイント
        this.setupAPIRoutes();
    }

    setupAPIRoutes() {
        // システム状態取得
        this.app.get('/api/status', (req, res) => {
            const clients = Array.from(this.connectedClients.values()).map(client => ({
                id: client.id,
                type: client.type,
                connected: client.connected,
                latency: client.latency,
                userAgent: client.userAgent
            }));

            res.json({
                system: {
                    ...this.systemStatus,
                    uptime: Math.floor((Date.now() - this.systemStatus.startTime) / 1000),
                    memory: process.memoryUsage(),
                    localIP: this.getLocalIP()
                },
                clients: clients,
                currentSession: this.currentSession,
                songs: this.songs.map(s => ({
                    id: s.id,
                    title: s.title,
                    duration: s.duration,
                    bpm: s.bpm
                }))
            });
        });

        // 楽曲データ取得
        this.app.get('/api/songs', (req, res) => {
            res.json(this.songs);
        });

        // 楽曲詳細取得
        this.app.get('/api/songs/:id', (req, res) => {
            const song = this.songs.find(s => s.id === req.params.id);
            if (song) {
                res.json(song);
            } else {
                res.status(404).json({ error: 'Song not found' });
            }
        });

        // 演奏開始
        this.app.post('/api/start', (req, res) => {
            const { songId, bpm } = req.body;
            const result = this.startPerformance(songId, bpm);
            res.json(result);
        });

        // 演奏停止
        this.app.post('/api/stop', (req, res) => {
            this.stopPerformance();
            res.json({ success: true, message: 'Performance stopped' });
        });

        // テンポ変更
        this.app.post('/api/tempo', (req, res) => {
            const { bpm } = req.body;
            this.changeTempo(bpm);
            res.json({ success: true, bpm: bpm });
        });
    }

    setupWebSocket() {
        this.wss = new WebSocket.Server({ port: this.wsPort });
        
        console.log(`🔗 WebSocket server started on port ${this.wsPort}`);

        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateClientId();
            const clientInfo = {
                id: clientId,
                ws: ws,
                type: null,
                connected: Date.now(),
                latency: 0,
                userAgent: req.headers['user-agent'] || 'Unknown',
                ip: req.socket.remoteAddress
            };

            this.connectedClients.set(clientId, clientInfo);
            console.log(`📱 Client connected: ${clientId} from ${req.socket.remoteAddress}`);

            // 接続確認メッセージ
            ws.send(JSON.stringify({
                type: 'welcome',
                clientId: clientId,
                serverTime: Date.now(),
                message: 'Connected to Piano Sync Server'
            }));

            // メッセージハンドラー
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleClientMessage(clientId, data);
                } catch (error) {
                    console.error('Invalid message format:', error);
                }
            });

            // 接続終了ハンドラー
            ws.on('close', () => {
                this.connectedClients.delete(clientId);
                console.log(`📱 Client disconnected: ${clientId}`);
                this.updateLEDStatus();
            });

            this.updateLEDStatus();
        });
    }

    setupGPIO() {
        if (!GPIO) return;

        try {
            // 物理ボタン設定
            this.buttons = {
                start: new GPIO(18, 'in', 'rising'),
                stop: new GPIO(23, 'in', 'rising'),
                next: new GPIO(24, 'in', 'rising'),
                prev: new GPIO(25, 'in', 'rising')
            };

            // LED設定
            this.leds = {
                status: new GPIO(21, 'out'),
                sync: new GPIO(20, 'out'),
                error: new GPIO(16, 'out')
            };

            // ボタンイベント設定
            this.buttons.start.watch((err, value) => {
                if (!err && value === 1) {
                    this.startPerformance();
                }
            });

            this.buttons.stop.watch((err, value) => {
                if (!err && value === 1) {
                    this.stopPerformance();
                }
            });

            console.log('🔧 GPIO controls initialized');
        } catch (error) {
            console.error('GPIO setup failed:', error);
        }
    }

    handleClientMessage(clientId, data) {
        const client = this.connectedClients.get(clientId);
        if (!client) return;

        switch (data.type) {
            case 'register':
                client.type = data.clientType;
                console.log(`📝 Client ${clientId} registered as ${data.clientType}`);
                
                // 登録後に現在の状態を送信
                if (this.currentSession && this.systemStatus.isPlaying) {
                    const currentTime = Date.now();
                    const elapsedTime = (currentTime - this.currentSession.startTime) / 1000;
                    
                    client.ws.send(JSON.stringify({
                        type: 'sync_start',
                        song: this.songs.find(s => s.id === this.currentSession.songId),
                        startTime: this.currentSession.startTime,
                        bpm: this.currentSession.bpm,
                        serverTime: currentTime,
                        elapsedTime: elapsedTime
                    }));
                }
                break;

            case 'ping':
                client.ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: data.timestamp,
                    serverTime: Date.now()
                }));
                break;

            case 'latency_report':
                client.latency = data.latency;
                break;

            case 'note_played':
                if (this.currentSession) {
                    this.currentSession.playedNotes++;
                    console.log(`Notes played: ${this.currentSession.playedNotes}/${this.currentSession.totalNotes}`);
                    
                    // 最後のノート演奏時刻を更新
                    this.lastNoteTime = Date.now();
                    
                    // 既存の無音タイマーをリセット
                    if (this.silenceTimeout) {
                        clearTimeout(this.silenceTimeout);
                    }

                    // 全ノート演奏完了で終了
                    if (this.currentSession.playedNotes >= this.currentSession.totalNotes) {
                        setTimeout(() => {
                            this.stopPerformance();
                        }, 1000); // 1秒の余韻
                        return; // ここでreturnして無音タイマー設定をスキップ
                    }
                    
                    // 新しい無音タイマーを設定
                    this.silenceTimeout = setTimeout(() => {
                        console.log('10秒間の無音を検知 - 演奏を自動停止');
                        this.stopPerformance();
                    }, this.maxSilenceDuration);

                }
                break;

            case 'ready':
                client.ready = true;
                this.checkAllClientsReady();
                break;

            case 'control':
                console.log('[DEBUG] Control message received:', data)
                this.handleControlMessage(data);
                break;
                
            case 'request_song_data':
                // 楽曲データリクエスト
                const songId = data.songId;
                const song = this.songs.find(s => s.id === songId);
                if (song) {
                    client.ws.send(JSON.stringify({
                        type: 'song_data',
                        song: song
                    }));
                }
                break;
        }
    }

    handleControlMessage(data) {
        console.log('[DEBUG] Control message received:', data);
        
        switch (data.action) {
            case 'start':
                this.startPerformance(data.songId, data.bpm);
                break;
            case 'stop':
                this.stopPerformance();
                break;
            case 'tempo':
                console.log('[DEBUG] Tempo change request:', data.bpm);
                this.changeTempo(data.bpm);
                break;
        }
    }

    startPerformance(songId = 'demo', bpm = 120, notesSettings = null) {
        const song = this.songs.find(s => s.id === songId) || this.songs[0];
    
        // 総ノート数を計算
        const totalNotes = (song.melody ? song.melody.length : 0) + 
                        (song.accompaniment ? song.accompaniment.length : 0);

        if (!song) {
            return { success: false, error: 'No songs available' };
        }

        // 現在時刻を使用（Date.nowではなくperformance.nowベース）
        const startTime = Date.now();

        // 無音検知の初期化
        this.lastNoteTime = Date.now();
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }

        this.currentSession = {
            songId: song.id,
            startTime: startTime,
            totalNotes: totalNotes,
            playedNotes: 0, // 演奏済みカウンター
            bpm: bpm,
            status: 'playing',
            duration: song.duration
        };

        this.systemStatus.isPlaying = true;
        this.systemStatus.currentSong = song.id;
        this.systemStatus.bpm = bpm;


        // 全クライアントに同期開始信号送信
        this.broadcastToAll({
            type: 'sync_start',
            song: song,
            startTime: startTime,
            bpm: bpm,
            serverTime: startTime,
            elapsedTime: 0 // 新規開始なので0
        });

        // LED制御
        if (this.leds) {
            this.leds.status.writeSync(1);
            this.leds.sync.writeSync(1);
        }

        return { success: true, song: song, startTime: startTime };
    }

    stopPerformance() {
        if (!this.currentSession) return;

        this.broadcastToAll({
            type: 'sync_stop',
            serverTime: Date.now()
        });

        this.currentSession = null;
        this.systemStatus.isPlaying = false;
        this.systemStatus.currentSong = null;

        // LED制御
        if (this.leds) {
            this.leds.status.writeSync(0);
            this.leds.sync.writeSync(0);
        }

        console.log('🛑 Performance stopped');
    }

    changeTempo(newBpm) {
        console.log('[DEBUG] changeTempo called with BPM:', newBpm);
        console.log('[DEBUG] Current session exists:', !!this.currentSession);
        
        if (this.currentSession) {
            console.log('[DEBUG] Updating session BPM from', this.currentSession.bpm, 'to', newBpm);
            
            this.currentSession.bpm = newBpm;
            this.systemStatus.bpm = newBpm;

            const message = {
                type: 'tempo_change',
                bpm: newBpm,
                serverTime: Date.now()
            };
            
            console.log('[DEBUG] Broadcasting tempo change message:', message);
            this.broadcastToAll(message);

            console.log(`Tempo changed to ${newBpm} BPM`);
        } else {
            console.log('[DEBUG] No current session, tempo change ignored');
        }
    }

    broadcastToAll(message) {
        this.connectedClients.forEach((client) => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(message));
            }
        });
    }

    async loadSongs() {
        try {
            // const songsPath = path.join(__dirname, 'songs', 'demo.json');
            const songsPath = path.join(__dirname, 'songs/output', 'midi_converted.json');
            if (fs.existsSync(songsPath)) {
                const songsData = fs.readFileSync(songsPath, 'utf8');
                this.songs = JSON.parse(songsData);
                console.log(`🎼 Loaded ${this.songs.length} songs`);
            } else {
                console.log('🎼 Nothins Songs');
            }
        } catch (error) {
            console.error('Failed to load songs:', error);
        }
    }

    checkAllClientsReady() {
        const clients = Array.from(this.connectedClients.values());
        const readyClients = clients.filter(c => c.ready);
        
        if (readyClients.length >= 2) {
            console.log('✅ All clients ready for synchronization');
        }
    }

    updateLEDStatus() {
        if (!this.leds) return;
        
        const clientCount = this.connectedClients.size;
        this.leds.sync.writeSync(clientCount >= 2 ? 1 : 0);
    }

    generateClientId() {
        return 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    getLocalIP() {
        try {
            const { networkInterfaces } = require('os');
            const nets = networkInterfaces();
            
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        return net.address;
                    }
                }
            }
            return 'localhost';
        } catch (error) {
            console.error('Error getting local IP:', error);
            return 'localhost';
        }
    }

    startServer() {
        this.server.listen(this.port, '0.0.0.0', () => {
            const localIP = this.getLocalIP();
            console.log('\n🎹 Piano Sync Server Started Successfully!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`🖥️  Control Panel:    http://${localIP}:${this.port}/`);
            console.log(`🎼 Right Hand (Melody): http://${localIP}:${this.port}/melody`);
            console.log(`🎵 Left Hand (Accomp):  http://${localIP}:${this.port}/accompaniment`);
            console.log(`🔗 WebSocket:           ws://${localIP}:${this.wsPort}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        });
    }

    // クリーンアップ処理
    cleanup() {
        console.log('\n🛑 Shutting down Piano Sync Server...');
        
        if (this.buttons) {
            Object.values(this.buttons).forEach(button => button.unexport());
        }
        if (this.leds) {
            Object.values(this.leds).forEach(led => {
                led.writeSync(0);
                led.unexport();
            });
        }
        
        if (this.wss) {
            this.wss.close();
        }
        
        if (this.server) {
            this.server.close();
        }
    }
}

// サーバー起動
const pianoServer = new PianoSyncServer();

// 終了処理
process.on('SIGINT', () => {
    pianoServer.cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    pianoServer.cleanup();
    process.exit(0);
});

module.exports = PianoSyncServer;