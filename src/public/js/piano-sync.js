/**
 * Piano Sync System - 同期システムJS
 * 高精度WebSocketベース同期システム
 */

class PianoSyncCore {
    constructor(options = {}) {
        this.options = {
            wsHost: options.wsHost || window.location.hostname,
            wsPort: options.wsPort || 8080,
            reconnectInterval: options.reconnectInterval || 3000,
            maxReconnectAttempts: options.maxReconnectAttempts || 10,
            latencyMeasureInterval: options.latencyMeasureInterval || 5000,
            syncThreshold: options.syncThreshold || 50, // ms
            ...options
        };

        // WebSocket接続
        this.ws = null;
        this.clientId = null;
        this.clientType = options.clientType || 'unknown';
        
        // 同期関連
        this.serverTimeOffset = 0;
        this.latency = 0;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        
        // 音楽関連
        this.audioContext = null;
        this.isPlaying = false;
        this.startTime = 0;
        this.currentSong = null;
        this.bpm = 120;
        
        // イベントハンドラー
        this.eventHandlers = {};
        
        // 初期化
        this.initialize();
    }

    async initialize() {
        try {
            // Web Audio API初期化
            await this.initializeWebAudio();
            
            // WebSocket接続
            this.connectWebSocket();
            
            // 定期的なレイテンシー測定
            setInterval(() => this.measureLatency(), this.options.latencyMeasureInterval);
            
            console.log('🎹 Piano Sync Core initialized');
        } catch (error) {
            console.error('❌ Failed to initialize Piano Sync Core:', error);
        }
    }

    async initializeWebAudio() {
        try {
            // ユーザーアクションが必要な場合に備えて
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            // コンテキストが停止している場合は再開
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            console.log('🎵 Web Audio API initialized');
        } catch (error) {
            console.error('Failed to initialize Web Audio API:', error);
            // フォールバックとしてperformance.nowを使用
        }
    }

    connectWebSocket() {
        const wsUrl = `ws://${this.options.wsHost}:${this.options.wsPort}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('🔗 Connected to Piano Sync Server');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                
                // クライアント登録
                this.send({
                    type: 'register',
                    clientType: this.clientType,
                    userAgent: navigator.userAgent,
                    timestamp: this.getCurrentTime()
                });
                
                this.emit('connected');
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleServerMessage(data);
                } catch (error) {
                    console.error('Invalid message format:', error);
                }
            };

            this.ws.onclose = () => {
                console.log('📱 Disconnected from Piano Sync Server');
                this.isConnected = false;
                this.emit('disconnected');
                
                // 自動再接続
                this.attemptReconnection();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.emit('error', error);
            };

        } catch (error) {
            console.error('Failed to connect WebSocket:', error);
            this.attemptReconnection();
        }
    }

    attemptReconnection() {
        if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.emit('connectionFailed');
            return;
        }

        this.reconnectAttempts++;
        console.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.options.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connectWebSocket();
        }, this.options.reconnectInterval);
    }

    handleServerMessage(data) {
        switch (data.type) {
            case 'welcome':
                this.clientId = data.clientId;
                this.emit('welcome', data);
                break;

            case 'sync_start':
                this.handleSyncStart(data);
                break;

            case 'sync_stop':
                this.handleSyncStop(data);
                break;

            case 'tempo_change':
                this.handleTempoChange(data);
                break;

            case 'pong':
                this.calculateLatency(data);
                break;

            default:
                this.emit('message', data);
        }
    }

    handleSyncStart(data) {
        console.log('🎵 Sync start received:', data);
        
        this.currentSong = data.song;
        this.bpm = data.bpm;
        
        // サーバー時刻を基準に開始時刻を計算
        const serverTime = data.serverTime;
        const localTime = Date.now();
        const networkDelay = this.latency / 2;
        
        // 同期補正
        this.serverTimeOffset = serverTime - localTime + networkDelay;
        
        // 既に開始済みの場合（途中参加）
        if (data.elapsedTime && data.elapsedTime > 0) {
            this.startTime = localTime - (data.elapsedTime * 1000);
            this.startPerformance();
        } else {
            // 新規開始
            this.startTime = data.startTime + this.serverTimeOffset;
            const delay = this.startTime - this.getCurrentTime();
            
            if (delay > 0) {
                setTimeout(() => {
                    this.startPerformance();
                }, delay);
            } else {
                this.startPerformance();
            }
        }
        
        this.emit('syncStart', {
            song: this.currentSong,
            startTime: this.startTime,
            bmp: this.bpm,
            delay: data.elapsedTime ? 0 : (this.startTime - this.getCurrentTime())
        });
    }

    handleSyncStop(data) {
        console.log('🛑 Sync stop received');
        
        this.isPlaying = false;
        this.currentSong = null;
        this.startTime = 0;
        
        this.emit('syncStop', data);
    }

    handleTempoChange(data) {
        console.log('🎶 Tempo change:', data.bpm);
        
        this.bpm = data.bpm;
        this.emit('tempoChange', data);
    }

    startPerformance() {
        if (!this.currentSong) {
            console.error('No song data available');
            return;
        }

        this.isPlaying = true;
        console.log('🎹 Performance started');
        
        this.emit('performanceStart', {
            song: this.currentSong,
            startTime: this.startTime
        });
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('WebSocket not connected, cannot send message');
        }
    }

    measureLatency() {
        if (!this.isConnected) return;
        
        const startTime = this.getCurrentTime();
        this.send({
            type: 'ping',
            timestamp: startTime
        });
    }

    calculateLatency(pongData) {
        const currentTime = this.getCurrentTime();
        const roundTripTime = currentTime - pongData.timestamp;
        this.latency = roundTripTime;
        
        // サーバー時刻オフセット更新
        const serverTime = pongData.serverTime;
        const networkDelay = roundTripTime / 2;
        this.serverTimeOffset = serverTime - currentTime + networkDelay;
        
        this.emit('latencyUpdate', {
            latency: this.latency,
            serverTimeOffset: this.serverTimeOffset
        });

        // 高レイテンシーの警告
        if (this.latency > this.options.syncThreshold) {
            console.warn(`⚠️ High latency detected: ${this.latency.toFixed(2)}ms`);
            this.emit('highLatency', { latency: this.latency });
        }
    }

    getCurrentTime() {
        if (this.audioContext && this.audioContext.state === 'running') {
            return this.audioContext.currentTime * 1000; // msに変換
        }
        return performance.now();
    }

    getMusicTime() {
        if (!this.isPlaying || !this.startTime) return 0;
        return (this.getCurrentTime() - this.startTime) / 1000; // 秒に変換
    }

    getServerTime() {
        return this.getCurrentTime() + this.serverTimeOffset;
    }

    // イベントシステム
    on(event, handler) {
        if (!this.eventHandlers[event]) {
            this.eventHandlers[event] = [];
        }
        this.eventHandlers[event].push(handler);
    }

    off(event, handler) {
        if (!this.eventHandlers[event]) return;
        
        const index = this.eventHandlers[event].indexOf(handler);
        if (index > -1) {
            this.eventHandlers[event].splice(index, 1);
        }
    }

    emit(event, data = null) {
        if (!this.eventHandlers[event]) return;
        
        this.eventHandlers[event].forEach(handler => {
            try {
                handler(data);
            } catch (error) {
                console.error(`Error in event handler for ${event}:`, error);
            }
        });
    }

    // 制御メソッド
    requestStart(songId = null, bpm = 120) {
        this.send({
            type: 'control',
            action: 'start',
            songId: songId,
            bpm: bpm,
            timestamp: this.getCurrentTime()
        });
    }

    requestStop() {
        this.send({
            type: 'control',
            action: 'stop',
            timestamp: this.getCurrentTime()
        });
    }

    requestTempoChange(newBpm) {
        this.send({
            type: 'control',
            action: 'tempo',
            bpm: newBpm,
            timestamp: this.getCurrentTime()
        });
    }

    // ユーティリティメソッド
    isWebSocketConnected() {
        return this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            clientId: this.clientId,
            latency: this.latency,
            serverTimeOffset: this.serverTimeOffset,
            isPlaying: this.isPlaying,
            currentSong: this.currentSong,
            bpm: this.bpm
        };
    }

    // Web Audio APIの再開（ユーザーアクション後に呼ぶ）
    async resumeAudioContext() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
                console.log('🎵 Audio context resumed');
                return true;
            } catch (error) {
                console.error('Failed to resume audio context:', error);
                return false;
            }
        }
        return true;
    }

    // クリーンアップ
    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        
        console.log('🔌 Piano Sync Core disconnected');
    }
}

// グローバルユーティリティ関数
window.PianoSyncUtils = {
    // ノート名からMIDIノート番号への変換
    noteToMidi(noteName) {
        const noteMap = {
            'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
            'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
            'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11
        };
        
        const match = noteName.match(/([A-G][#b]?)(\d)/);
        if (!match) return null;
        
        const note = noteMap[match[1]];
        const octave = parseInt(match[2]);
        
        return (octave + 1) * 12 + note;
    },

    // MIDIノート番号からノート名への変換
    midiToNote(midiNote) {
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midiNote / 12) - 1;
        const note = notes[midiNote % 12];
        return note + octave;
    },

    // BPMから拍間隔（ms）を計算
    bpmToInterval(bpm) {
        return (60 / bpm) * 1000;
    },

    // 時間をBPMベースの拍に変換
    timeToBeat(timeMs, bpm) {
        const beatInterval = this.bpmToInterval(bpm);
        return timeMs / beatInterval;
    },

    // 拍を時間（ms）に変換
    beatToTime(beat, bpm) {
        const beatInterval = this.bpmToInterval(bpm);
        return beat * beatInterval;
    },

    // レイテンシーに基づく同期補正
    calculateSyncOffset(latency, targetLatency = 10) {
        return Math.max(0, latency - targetLatency);
    },

    // 色相からRGBへの変換（ノート表示用）
    hslToRgb(h, s, l) {
        h /= 360;
        s /= 100;
        l /= 100;
        
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };

        let r, g, b;
        if (s === 0) {
            r = g = b = l;
        } else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    },

    // ノート番号から色を生成
    noteToColor(midiNote) {
        const hue = (midiNote * 30) % 360;
        const [r, g, b] = this.hslToRgb(hue, 70, 60);
        return `rgb(${r}, ${g}, ${b})`;
    },

    // デバッグ用のパフォーマンス測定
    performanceMonitor: {
        measurements: {},
        
        start(name) {
            this.measurements[name] = performance.now();
        },
        
        end(name) {
            if (this.measurements[name]) {
                const duration = performance.now() - this.measurements[name];
                console.log(`⏱️ ${name}: ${duration.toFixed(2)}ms`);
                delete this.measurements[name];
                return duration;
            }
            return null;
        }
    }
};

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PianoSyncCore;
} else {
    window.PianoSyncCore = PianoSyncCore;
}