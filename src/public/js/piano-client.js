/**
 * Piano Client - タブレット用クライアント
 * ノーツ表示と演奏インターフェース
 */

class PianoClient {
    constructor(clientType, options = {}) {
        this.clientType = clientType; // 'melody' or 'accompaniment'
        this.options = {
            noteSpeed: options.noteSpeed || 120, // pixels per second
            lookAhead: options.lookAhead || 5, // seconds
            fallbackColor: clientType === 'melody' ? '#2196F3' : '#4CAF50',
            ...options
        };

        // DOM要素
        this.container = null;
        this.notesContainer = null;
        this.keyboardGuide = null;
        this.statusIndicator = null;
        this.bpmDisplay = null;
        this.timelineProgress = null;

        // 同期システム
        this.syncCore = null;
        
        // 演奏状態
        this.currentSong = null;
        this.activeNotes = new Map();
        this.animationId = null;
        
        // パフォーマンス最適化
        this.lastFrameTime = 0;
        this.frameRate = 60;
        this.frameInterval = 1000 / this.frameRate;

        this.initialize();
    }

    async initialize() {
        try {
            // DOM初期化
            this.setupDOM();
            
            // 同期システム初期化
            this.syncCore = new PianoSyncCore({
                clientType: this.clientType
            });

            // イベントハンドラー設定
            this.setupEventHandlers();
            
            // タッチ/クリック対応
            this.setupInteraction();

            console.log(`🎹 Piano Client (${this.clientType}) initialized`);
        } catch (error) {
            console.error('Failed to initialize Piano Client:', error);
        }
    }

    setupDOM() {
        this.container = document.querySelector('.piano-display') || document.body;
        
        // ノーツコンテナ
        this.notesContainer = document.createElement('div');
        this.notesContainer.className = 'notes-container';
        this.notesContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
        `;
        this.container.appendChild(this.notesContainer);

        // 鍵盤ガイド
        this.createKeyboardGuide();

        // ステータス表示
        this.createStatusIndicators();

        // タイムライン
        this.createTimeline();
    }

    createKeyboardGuide() {
        this.keyboardGuide = document.createElement('div');
        this.keyboardGuide.className = 'keyboard-guide';
        
        // ピアノの鍵盤を作成（Cメジャースケール）
        const whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        const blackKeys = ['C#', 'D#', '', 'F#', 'G#', 'A#', ''];

        whiteKeys.forEach((note, index) => {
            const whiteKey = document.createElement('div');
            whiteKey.className = 'key white';
            whiteKey.dataset.note = note + '4'; // オクターブ4
            whiteKey.style.cssText = `
                width: 40px;
                height: 120px;
                background: white;
                border: 1px solid #ccc;
                border-radius: 0 0 4px 4px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                transition: all 0.1s ease;
            `;
            this.keyboardGuide.appendChild(whiteKey);

            // 黒鍵
            if (blackKeys[index]) {
                const blackKey = document.createElement('div');
                blackKey.className = 'key black';
                blackKey.dataset.note = blackKeys[index] + '4';
                blackKey.style.cssText = `
                    width: 25px;
                    height: 80px;
                    background: #333;
                    border-radius: 0 0 3px 3px;
                    margin-left: -12.5px;
                    margin-right: -12.5px;
                    z-index: 2;
                    position: relative;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
                    transition: all 0.1s ease;
                `;
                this.keyboardGuide.appendChild(blackKey);
            }
        });

        this.container.appendChild(this.keyboardGuide);
    }

    createStatusIndicators() {
        // 接続状態
        this.statusIndicator = document.createElement('div');
        this.statusIndicator.className = 'connection-status';
        this.statusIndicator.innerHTML = `
            <span class="status-indicator status-connecting"></span>
            <span>接続中...</span>
        `;
        this.container.appendChild(this.statusIndicator);

        // BPM表示
        this.bpmDisplay = document.createElement('div');
        this.bpmDisplay.className = 'bpm-display';
        this.bpmDisplay.textContent = 'BPM: --';
        this.container.appendChild(this.bpmDisplay);

        // 手の表示
        const handIndicator = document.createElement('div');
        handIndicator.className = 'hand-indicator';
        handIndicator.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 48px;
            opacity: 0.3;
            pointer-events: none;
            z-index: 1;
        `;
        handIndicator.textContent = this.clientType === 'melody' ? '👉' : '🖐️';
        this.container.appendChild(handIndicator);
    }

    createTimeline() {
        this.timeline = document.createElement('div');
        this.timeline.className = 'timeline';
        
        this.timelineProgress = document.createElement('div');
        this.timelineProgress.className = 'timeline-progress';
        this.timeline.appendChild(this.timelineProgress);
        
        this.container.appendChild(this.timeline);
    }

    setupEventHandlers() {
        // 同期システムイベント
        this.syncCore.on('connected', () => {
            this.updateConnectionStatus('connected', '同期サーバーに接続');
            
            // ローディング画面を隠す（存在する場合）
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.opacity = '0';
                setTimeout(() => {
                    loadingOverlay.style.display = 'none';
                }, 300);
            }
        });

        this.syncCore.on('disconnected', () => {
            this.updateConnectionStatus('disconnected', '接続が切断されました');
        });

        this.syncCore.on('connectionFailed', () => {
            // エラーメッセージを表示（存在する場合）
            const errorElement = document.getElementById('errorMessage');
            const errorText = document.getElementById('errorText');
            const loadingOverlay = document.getElementById('loadingOverlay');
            
            if (errorText) errorText.textContent = 'サーバーに接続できませんでした';
            if (errorElement) errorElement.style.display = 'block';
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        });

        this.syncCore.on('syncStart', (data) => {
            this.startPerformance(data);
        });

        this.syncCore.on('syncStop', () => {
            this.stopPerformance();
        });

        this.syncCore.on('tempoChange', (data) => {
            this.updateBPM(data.bpm);
        });

        this.syncCore.on('latencyUpdate', (data) => {
            this.updateLatencyDisplay(data.latency);
        });

        // ページの可視性変更
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.resumePerformance();
            } else {
                this.pausePerformance();
            }
        });

        // ウィンドウリサイズ
        window.addEventListener('resize', () => {
            this.handleResize();
        });
    }

    setupInteraction() {
        // タッチで音声コンテキストを再開
        const resumeAudio = async () => {
            await this.syncCore.resumeAudioContext();
            document.removeEventListener('touchstart', resumeAudio);
            document.removeEventListener('click', resumeAudio);
        };

        document.addEventListener('touchstart', resumeAudio, { once: true });
        document.addEventListener('click', resumeAudio, { once: true });

        // 鍵盤インタラクション
        this.keyboardGuide.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.handleKeyPress(e.target);
        });

        this.keyboardGuide.addEventListener('click', (e) => {
            this.handleKeyPress(e.target);
        });

        // スクリーンロック防止
        this.preventScreenLock();
    }

    preventScreenLock() {
        // Wake Lock API
        if ('wakeLock' in navigator) {
            navigator.wakeLock.request('screen').catch(err => {
                console.log('Wake lock failed:', err);
            });
        }

        // フェイクビデオを使用したフォールバック
        const video = document.createElement('video');
        video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc284NWF2YzEAAAAIZnJlZQAACKBtZGF0AAAC';
        video.muted = true;
        video.loop = true;
        video.play().catch(() => {}); // エラーを無視
    }

    startPerformance(data) {
        console.log(`🎵 Starting ${this.clientType} performance`);
        console.log('Song data:', data.song);
        console.log(`Notes for ${this.clientType}:`, data.song[this.clientType]);
        
        this.currentSong = data.song;
        this.updateBPM(data.bpm);
        this.clearNotes();
        
        // アニメーション開始
        this.startAnimation();
        
        // 背景色を変更して演奏中を示す
        document.body.style.background = `linear-gradient(135deg, ${this.options.fallbackColor}22, #1a1a1a)`;
    }

    stopPerformance() {
        console.log(`🛑 Stopping ${this.clientType} performance`);
        
        this.currentSong = null;
        this.stopAnimation();
        this.clearNotes();
        
        // 背景色をリセット
        document.body.style.background = '#1a1a1a';
        
        // タイムラインリセット
        if (this.timelineProgress) {
            this.timelineProgress.style.width = '0%';
        }
    }

    startAnimation() {
        if (this.animationId) return;
        
        const animate = (timestamp) => {
            if (!this.currentSong) return;
            
            // フレームレート制御
            if (timestamp - this.lastFrameTime >= this.frameInterval) {
                this.updateNotes();
                this.updateTimeline();
                this.lastFrameTime = timestamp;
            }
            
            this.animationId = requestAnimationFrame(animate);
        };
        
        this.animationId = requestAnimationFrame(animate);
    }

    stopAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    updateNotes() {
        if (!this.currentSong || !this.syncCore.isPlaying) return;
        
        const currentTime = this.syncCore.getMusicTime();
        const notes = this.currentSong[this.clientType] || [];
        
        // 既存のノーツをクリア
        this.clearNotes();
        
        // 表示するノーツを計算
        notes.forEach(noteData => {
            const timeUntilNote = noteData.time - currentTime;
            
            // 先読み範囲内のノーツのみ表示
            if (timeUntilNote > 0 && timeUntilNote <= this.options.lookAhead) {
                this.createNoteElement(noteData, timeUntilNote);
            }
            
            // ヒットタイミングのチェック
            if (Math.abs(timeUntilNote) < 0.1) { // 100ms以内
                this.highlightKey(noteData.note);
            }
        });
    }

    createNoteElement(noteData, timeUntilNote) {
        const note = document.createElement('div');
        note.className = `note ${this.clientType}`;
        note.textContent = noteData.note;
        note.dataset.noteId = `${noteData.note}_${noteData.time}`;
        
        // 位置計算
        const containerHeight = this.container.clientHeight;
        const progress = (this.options.lookAhead - timeUntilNote) / this.options.lookAhead;
        const topPosition = progress * (containerHeight - 150); // 鍵盤上150px手前まで
        
        // スタイル設定
        note.style.cssText = `
            position: absolute;
            top: ${topPosition}px;
            left: ${noteData.position}px;
            width: ${this.clientType === 'melody' ? '50px' : '45px'};
            height: ${this.clientType === 'melody' ? '50px' : '45px'};
            border-radius: 50%;
            background: ${this.options.fallbackColor};
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            z-index: 10;
            transition: transform 0.1s ease;
        `;
        
        // 指番号表示
        if (noteData.finger) {
            const fingerIndicator = document.createElement('span');
            fingerIndicator.textContent = noteData.finger;
            fingerIndicator.style.cssText = `
                position: absolute;
                top: -10px;
                right: -10px;
                width: 20px;
                height: 20px;
                background: rgba(255,255,255,0.9);
                color: #333;
                border-radius: 50%;
                font-size: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            note.appendChild(fingerIndicator);
        }
        
        this.notesContainer.appendChild(note);
        this.activeNotes.set(note.dataset.noteId, note);
    }

    highlightKey(noteName) {
        // 対応する鍵盤をハイライト
        const key = this.keyboardGuide.querySelector(`[data-note="${noteName}"]`);
        if (key) {
            key.classList.add('active');
            key.style.background = this.options.fallbackColor;
            
            // 短時間後にハイライトを解除
            setTimeout(() => {
                key.classList.remove('active');
                key.style.background = key.classList.contains('black') ? '#333' : 'white';
            }, 200);
        }
    }

    updateTimeline() {
        if (!this.currentSong || !this.timelineProgress) return;
        
        const currentTime = this.syncCore.getMusicTime();
        const progress = Math.min((currentTime / this.currentSong.duration) * 100, 100);
        this.timelineProgress.style.width = `${progress}%`;
    }

    clearNotes() {
        this.notesContainer.innerHTML = '';
        this.activeNotes.clear();
    }

    updateConnectionStatus(status, message) {
        if (!this.statusIndicator) return;
        
        const indicator = this.statusIndicator.querySelector('.status-indicator');
        const text = this.statusIndicator.querySelector('span:last-child');
        
        indicator.className = `status-indicator status-${status}`;
        text.textContent = message;
    }

    updateBPM(bpm) {
        if (this.bpmDisplay) {
            this.bpmDisplay.textContent = `BPM: ${bpm}`;
        }
    }

    updateLatencyDisplay(latency) {
        if (this.statusIndicator && latency > 0) {
            const latencyText = this.statusIndicator.querySelector('.latency-text') || 
                               (() => {
                                   const span = document.createElement('span');
                                   span.className = 'latency-text';
                                   span.style.marginLeft = '10px';
                                   span.style.fontSize = '12px';
                                   span.style.opacity = '0.7';
                                   this.statusIndicator.appendChild(span);
                                   return span;
                               })();
            
            latencyText.textContent = `${latency.toFixed(0)}ms`;
            
            // 高レイテンシーの警告
            if (latency > 50) {
                latencyText.style.color = '#ff9800';
            } else {
                latencyText.style.color = '';
            }
        }
    }

    handleKeyPress(key) {
        if (!key.dataset.note) return;
        
        // 視覚的フィードバック
        key.style.transform = 'translateY(2px)';
        key.style.background = this.options.fallbackColor;
        
        setTimeout(() => {
            key.style.transform = '';
            key.style.background = key.classList.contains('black') ? '#333' : 'white';
        }, 150);
        
        // 音声フィードバック（オプション）
        this.playNoteSound(key.dataset.note);
    }

    playNoteSound(noteName) {
        if (!this.syncCore.audioContext) return;
        
        try {
            const midiNote = PianoSyncUtils.noteToMidi(noteName);
            if (!midiNote) return;
            
            // 簡単なサイン波での音生成
            const oscillator = this.syncCore.audioContext.createOscillator();
            const gainNode = this.syncCore.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.syncCore.audioContext.destination);
            
            // 周波数計算 (A4 = 440Hz)
            const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);
            oscillator.frequency.value = frequency;
            
            // エンベロープ
            const now = this.syncCore.audioContext.currentTime;
            gainNode.gain.setValueAtTime(0.1, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
            
            oscillator.start(now);
            oscillator.stop(now + 0.5);
        } catch (error) {
            console.log('Sound play failed:', error);
        }
    }

    handleResize() {
        // リサイズ時の処理
        this.clearNotes();
    }

    resumePerformance() {
        if (this.currentSong && !this.animationId) {
            this.startAnimation();
        }
    }

    pausePerformance() {
        this.stopAnimation();
    }

    // クリーンアップ
    destroy() {
        this.stopAnimation();
        this.clearNotes();
        
        if (this.syncCore) {
            this.syncCore.disconnect();
        }
        
        console.log(`🔌 Piano Client (${this.clientType}) destroyed`);
    }
}

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PianoClient;
} else {
    window.PianoClient = PianoClient;
}