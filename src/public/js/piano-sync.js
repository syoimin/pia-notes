/**
 * Piano Sync System - 同期システムJS
 * 高精度WebSocketベース同期システム（テンポ変更対応版）
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
        this.originalBpm = 120;
        this.currentBpm = 120;
        
        // テンポ変更追跡用
        this.tempoChanges = []; // {time, oldBpm, newBpm, musicTimeAtChange}
        this.baseMusicTime = 0; // テンポ変更時の基準音楽時間
        this.lastTempoChangeTime = 0; // 最後のテンポ変更時刻
        
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
            
            console.log('Piano Sync Core initialized');
        } catch (error) {
            console.error('Failed to initialize Piano Sync Core:', error);
        }
    }

    async initializeWebAudio() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            if (this.audioContext.state === 'suspended') {
                console.log('[DEBUG] AudioContext suspended, will resume on user interaction');
                // ユーザーアクション後に再開される予定なので、ここではエラーを投げない
            }
            
            console.log('[DEBUG] Web Audio API initialized (state:', this.audioContext.state, ')');
        } catch (error) {
            console.warn('[DEBUG] Web Audio API initialization failed:', error);
            // AudioContextが使えなくてもWebSocket接続は可能なので、エラーを投げない
        }
    }

    connectWebSocket() {
        const wsUrl = `ws://${this.options.wsHost}:${this.options.wsPort}`;
        console.log('[DEBUG] connectWebSocket called, URL:', wsUrl);
        
        try {
            console.log('[DEBUG] Creating WebSocket...');
            this.ws = new WebSocket(wsUrl);
            console.log('[DEBUG] WebSocket created:', this.ws);
            console.log('[DEBUG] Initial readyState:', this.ws.readyState);
            
            this.ws.onopen = () => {
                console.log('[DEBUG] WebSocket onopen fired');
                console.log('Connected to Piano Sync Server');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                
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

            this.ws.onclose = (event) => {
                console.log('[DEBUG] WebSocket onclose fired:', event.code, event.reason);
                console.log('Disconnected from Piano Sync Server');
                this.isConnected = false;
                this.emit('disconnected');
                this.attemptReconnection();
            };

            this.ws.onerror = (error) => {
                console.error('[DEBUG] WebSocket onerror fired:', error);
                console.error('WebSocket error:', error);
                this.emit('error', error);
            };

        } catch (error) {
            console.error('[DEBUG] Exception in connectWebSocket:', error);
            console.error('Failed to connect WebSocket:', error);
            this.attemptReconnection();
        }
    }

    attemptReconnection() {
        if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            this.emit('connectionFailed');
            return;
        }

        this.reconnectAttempts++;
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.options.maxReconnectAttempts})...`);
        
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

            case 'sync_pause':
                this.handleSyncPause(data);
                break;

            case 'sync_resume':
                this.handleSyncResume(data);
                break;

            case 'pong':
                this.calculateLatency(data);
                break;

            default:
                this.emit('message', data);
        }
    }

    handleSyncStart(data) {
        console.log('Sync start received:', data);
        
        this.currentSong = data.song;
        this.originalBpm = data.bpm;
        this.currentBpm = data.bpm;
        
        // テンポ変更履歴をリセット
        this.tempoChanges = [];
        this.baseMusicTime = 0;
        this.lastTempoChangeTime = 0;
        
        const currentTime = performance.now();
        
        if (data.elapsedTime && data.elapsedTime > 0) {
            // 途中参加の場合
            this.startTime = currentTime - (data.elapsedTime * 1000);
            this.baseMusicTime = data.elapsedTime;
            this.lastTempoChangeTime = currentTime;
            console.log(`Joining mid-performance: elapsed=${data.elapsedTime}s`);
        } else {
            // 新規開始
            this.startTime = currentTime;
            this.baseMusicTime = 0;
            this.lastTempoChangeTime = currentTime;
            console.log(`New performance start`);
        }
        
        this.isPlaying = true;
        this.emit('syncStart', {
            song: this.currentSong,
            startTime: this.startTime,
            bpm: this.currentBpm,
            delay: 0
        });
        
        this.emit('performanceStart', {
            song: this.currentSong,
            startTime: this.startTime
        });
    }

    handleSyncStop(data) {
        console.log('Sync stop received');
        
        this.isPlaying = false;
        this.currentSong = null;
        this.startTime = 0;
        this.tempoChanges = [];
        this.baseMusicTime = 0;
        this.lastTempoChangeTime = 0;
        
        this.emit('syncStop', data);
    }

    handleTempoChange(data) {
        console.log('🎶 [DEBUG] Tempo change received:', data);
        
        const currentTime = this.getCurrentTime();
        const oldMusicTime = this.getMusicTime();
        
        console.log('🎶 [DEBUG] Before tempo change:');
        console.log('  - Current time:', currentTime);
        console.log('  - Old music time:', oldMusicTime.toFixed(3));
        console.log('  - Current BPM:', this.currentBpm);
        console.log('  - New BPM:', data.bpm);
        console.log('  - Base music time:', this.baseMusicTime.toFixed(3));
        console.log('  - Last tempo change time:', this.lastTempoChangeTime);
        
        // テンポ変更を記録
        this.tempoChanges.push({
            time: currentTime,
            oldBpm: this.currentBpm,
            newBpm: data.bpm,
            musicTimeAtChange: oldMusicTime
        });
        
        // 新しいテンポ設定
        const oldBpm = this.currentBpm;
        this.currentBpm = data.bpm;
        this.baseMusicTime = oldMusicTime;
        this.lastTempoChangeTime = currentTime;
        
        console.log('🎶 [DEBUG] After tempo change:');
        console.log('  - Updated current BPM:', this.currentBpm);
        console.log('  - Updated base music time:', this.baseMusicTime.toFixed(3));
        console.log('  - Updated last tempo change time:', this.lastTempoChangeTime);
        console.log('  - Tempo changes count:', this.tempoChanges.length);
        
        // 即座にgetMusicTimeをテスト
        setTimeout(() => {
            const newMusicTime = this.getMusicTime();
            console.log('🎶 [DEBUG] Music time 100ms after tempo change:', newMusicTime.toFixed(3));
        }, 100);
        
        this.emit('tempoChange', {
            ...data,
            musicTime: oldMusicTime,
            oldBpm: oldBpm
        });
    }

    handleSyncPause(data) {
        console.log('Sync pause received');
        this.isPlaying = false;
        this.emit('syncPause', data);
    }

    handleSyncResume(data) {
        console.log('Sync resume received:', data);
        
        this.currentSong = data.song;
        this.originalBpm = data.bpm;
        this.currentBpm = data.bpm;
        
        // 再開時の時間調整
        this.startTime = data.startTime;
        this.baseMusicTime = data.elapsedTime || 0;
        this.lastTempoChangeTime = Date.now();
        
        this.isPlaying = true;
        this.emit('syncResume', data);
    }

    getMusicTime() {
        if (!this.isPlaying || !this.startTime) {
            console.log('🎵 [DEBUG] getMusicTime: Not playing');
            return 0;
        }
        
        const currentTime = this.getCurrentTime();
        
        if (this.tempoChanges.length === 0) {
            // テンポ変更がない場合は単純計算
            const realTimeElapsed = (currentTime - this.startTime) / 1000;
            const musicTime = Math.max(0, realTimeElapsed);
            
            console.log('🎵 [DEBUG] getMusicTime (no tempo changes):');
            console.log('  - Real time elapsed:', realTimeElapsed.toFixed(3));
            console.log('  - Music time:', musicTime.toFixed(3));
            
            return musicTime;
        }
        
        // 最後のテンポ変更からの経過時間を計算
        const timeSinceLastChange = (currentTime - this.lastTempoChangeTime) / 1000;
        
        // 現在のテンポでの音楽時間を計算
        const tempoRatio = this.currentBpm / this.originalBpm;
        const musicTimeElapsed = timeSinceLastChange * tempoRatio;
        
        const totalMusicTime = this.baseMusicTime + musicTimeElapsed;
        
        // 詳細デバッグログ
        console.log('🎵 [DEBUG] getMusicTime (with tempo changes):');
        console.log('  - Current time:', currentTime.toFixed(3));
        console.log('  - Last tempo change time:', this.lastTempoChangeTime.toFixed(3));
        console.log('  - Time since last change:', timeSinceLastChange.toFixed(3));
        console.log('  - Original BPM:', this.originalBpm);
        console.log('  - Current BPM:', this.currentBpm);
        console.log('  - Tempo ratio:', tempoRatio.toFixed(3));
        console.log('  - Music time elapsed since change:', musicTimeElapsed.toFixed(3));
        console.log('  - Base music time:', this.baseMusicTime.toFixed(3));
        console.log('  - Total music time:', totalMusicTime.toFixed(3));
        console.log('  - Tempo changes count:', this.tempoChanges.length);
        
        return Math.max(0, totalMusicTime);
    }

    // テンポを考慮したビート計算
    getCurrentBeat() {
        const musicTime = this.getMusicTime();
        const beatsPerSecond = this.currentBpm / 60;
        return musicTime * beatsPerSecond;
    }

    // 小節数計算
    getCurrentMeasure(timeSignature = 4) {
        const beat = this.getCurrentBeat();
        return Math.floor(beat / timeSignature) + 1;
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
        
        const serverTime = pongData.serverTime;
        const networkDelay = roundTripTime / 2;
        this.serverTimeOffset = serverTime - currentTime + networkDelay;
        
        this.emit('latencyUpdate', {
            latency: this.latency,
            serverTimeOffset: this.serverTimeOffset
        });

        if (this.latency > this.options.syncThreshold) {
            console.warn(`High latency detected: ${this.latency.toFixed(2)}ms`);
            this.emit('highLatency', { latency: this.latency });
        }
    }

    getCurrentTime() {
        return performance.now();
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
        console.log('[DEBUG] requestTempoChange called with BPM:', newBpm);
        console.log('[DEBUG] Current connection status:', this.isWebSocketConnected());
        console.log('[DEBUG] WebSocket ready state:', this.ws ? this.ws.readyState : 'null');
        
        this.send({
            type: 'control',
            action: 'tempo',
            bpm: newBpm,
            timestamp: this.getCurrentTime()
        });
        
        console.log('[DEBUG] Tempo change request sent to server');
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
            originalBpm: this.originalBpm,
            currentBpm: this.currentBpm,
            musicTime: this.getMusicTime(),
            currentBeat: this.getCurrentBeat()
        };
    }

    // Web Audio APIの再開
    async resumeAudioContext() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
                console.log('Audio context resumed');
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
        
        console.log('Piano Sync Core disconnected');
    }
}

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PianoSyncCore;
} else {
    window.PianoSyncCore = PianoSyncCore;
}