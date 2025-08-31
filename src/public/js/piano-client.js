/**
 * Piano Client - タブレット用クライアント (88鍵グランドピアノ対応)
 * 改良版: 高速で縦長のノーツ表示に対応
 */

class PianoClient {
    constructor(clientType, options = {}) {
        this.clientType = clientType; // 'melody' or 'accompaniment'
        this.playedNotes = new Set(); // 演奏済みノートを記録
        this.options = {
            lookAhead: options.lookAhead || 2, // 先読み時間を延長 (5→8秒)
            fallbackColor: clientType === 'melody' ? '#2196F3' : '#4CAF50',
            minNoteHeight: options.minNoteHeight || 60, // 最小ノート高さ
            maxNoteHeight: options.maxNoteHeight || 200, // 最大ノート高さ
            noteHeightMultiplier: options.noteHeightMultiplier || 120, // 長さ計算係数
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
        this.autoStopTimer = null;
        this.endingSoon = false;
        
        // パフォーマンス最適化
        this.lastFrameTime = 0;
        this.frameRate = 60;
        this.frameInterval = 1000 / 60; // 60FPS固定

        // ノーツサイズ定数（ヒット判定用）
        this.NOTE_HEIGHT = {
            melody: 20,
            accompaniment: 45
        };
        this.NOTE_WIDTH = {
            melody: 20,
            accompaniment: 45
        };

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

            // console.log(`🎹 Piano Client (${this.clientType}) initialized`);
        } catch (error) {
            console.error('Failed to initialize Piano Client:', error);
        }
    }

    setupDOM() {
        this.container = document.querySelector('.piano-display') || document.body;
        
        // 既存のDOM要素を使用するかチェック
        if (!this.options.useExistingDOM) {
        } else {
            // 既存のDOM要素を使用
            this.notesContainer = document.getElementById('notesContainer') || this.container.querySelector('.notes-container');
            this.keyboardGuide = document.getElementById('keyboardGuide') || this.container.querySelector('.keyboard-guide');
            this.statusIndicator = document.getElementById('connectionStatus') || this.container.querySelector('.connection-status');
            this.bpmDisplay = document.getElementById('bpmDisplay') || this.container.querySelector('.bpm-display');
            this.timelineProgress = document.getElementById('timelineProgress') || this.container.querySelector('.timeline-progress');
        }
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

        // piano-client.js の skipNotesComplete イベントハンドラーを修正
        this.syncCore.on('skipNotesComplete', (data) => {
            // ノーツをクリアして再描画
            this.clearNotes();
            this.playedNotes.clear(); // 重要: 演奏済みセットをクリア
            
            // 楽曲情報を更新
            this.currentSong = data.song;
            
            // *** 重要: 演奏済みノーツセットを再構築 ***
            if (data.song && data.targetNoteIndex > 0) {
                const allNotes = [];
                if (data.song.melody) {
                    data.song.melody.forEach(note => allNotes.push({...note, type: 'melody'}));
                }
                if (data.song.accompaniment) {
                    data.song.accompaniment.forEach(note => allNotes.push({...note, type: 'accompaniment'}));
                }
                allNotes.sort((a, b) => a.time - b.time);
                
                // 目標位置より前のノーツを演奏済みとしてマーク
                for (let i = 0; i < data.targetNoteIndex && i < allNotes.length; i++) {
                    const note = allNotes[i];
                    const noteId = `${note.note}_${note.time}`;
                    this.playedNotes.add(noteId);
                }
                
                console.log(`[DEBUG] Rebuilt playedNotes set with ${this.playedNotes.size} notes`);
            }
            
            console.log(`🎵 Client skipped ${data.direction} ${data.noteCount} notes to position: ${data.targetTime.toFixed(2)}s`);
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
        if (this.keyboardGuide) {
            this.keyboardGuide.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.handleKeyPress(e.target);
            });

            this.keyboardGuide.addEventListener('click', (e) => {
                this.handleKeyPress(e.target);
            });
        }

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
        // console.log(`🎵 Starting ${this.clientType} performance`);
        // console.log('Song data:', data.song);
        // console.log(`Notes for ${this.clientType}:`, data.song[this.clientType]);

        this.currentSong = data.song;
        this.updateBPM(data.bpm);
        this.clearNotes();
        this.endingSoon = false; // 終了フラグをリセット
        
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
        this.playedNotes.clear();
        
        // 背景色をリセット
        document.body.style.background = '#1a1a1a';
        
        // タイムラインリセット
        const timelineElement = document.getElementById('timelineProgress') || this.timelineProgress;
        if (timelineElement) {
            timelineElement.style.width = '0%';
        }
    }

    startAnimation() {
        if (this.animationId) {
            console.log('⚠️ Animation already running');
            return;
        }
        
        console.log('🎬 Starting animation loop');
        
        const animate = (timestamp) => {
            if (!this.currentSong) {
                console.log('❌ Animation stopped - no current song');
                return;
            }
            
            // 毎フレーム実行（60FPS）
            this.updateNotes();
            this.updateTimeline();
            
            this.animationId = requestAnimationFrame(animate);
        };
        
        this.animationId = requestAnimationFrame(animate);
        console.log('✅ Animation loop started with ID:', this.animationId);
    }

    stopAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    updateNotes() {
        if (!this.currentSong || !this.syncCore.isPlaying) {
            return;
        }
        
        const currentTime = this.syncCore.getMusicTime();
        const notes = this.currentSong[this.clientType] || [];
        
        // 既存ノーツの位置を更新
        this.updateExistingNotes(currentTime);
        
        // 新しいノーツを追加
        this.addNewNotes(notes, currentTime);
        
        // 画面外のノーツを削除
        this.removeOffscreenNotes();
        
        // ヒットタイミングのチェック
        this.checkHitTiming(notes, currentTime);
    }

    updateExistingNotes(currentTime) {
        const containerHeight = this.container.clientHeight;
        
        // BPMが0の場合は位置更新をスキップ
        if (this.syncCore.currentBpm === 0) {
            return;
        }

        this.activeNotes.forEach((noteElement, noteId) => {
            const parts = noteId.split('_');
            const noteTime = parseFloat(parts[1]);
            const timeUntilNote = noteTime - currentTime;
            
            if (timeUntilNote > -2 && timeUntilNote <= this.options.lookAhead) {
                // 高速落下計算
                const progress = (this.options.lookAhead - timeUntilNote) / this.options.lookAhead;
                
                // 鍵盤ガイドの位置を取得
                const keyboardGuideRect = this.keyboardGuide.getBoundingClientRect();
                const containerRect = this.container.getBoundingClientRect();
                const keyboardTopRelative = keyboardGuideRect.top - containerRect.top;
                
                // ノート高さを取得（data属性から）
                const noteHeight = parseFloat(noteElement.dataset.noteHeight) || this.options.minNoteHeight;
                
                // 終点: ノーツの底が鍵盤上部に到達する位置
                const targetPosition = keyboardTopRelative - noteHeight;
                
                // 開始点: 画面上端より上
                const startPosition = -noteHeight - 100;
                
                // 現在位置を計算（高速移動）
                const totalDistance = targetPosition - startPosition;
                const newTop = startPosition + (progress * totalDistance);
                
                noteElement.style.top = `${newTop}px`;
                
                // ヒット直前の視覚効果
                // const distanceToTarget = targetPosition - newTop;
                // if (distanceToTarget < 30 && distanceToTarget > -10) {
                //     noteElement.style.transform = 'scale(1.1)';
                //     noteElement.style.boxShadow = '0 0 20px rgba(255, 152, 0, 0.8)';
                // } else {
                //     noteElement.style.transform = 'scale(1)';
                //     noteElement.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
                // }
                
            } else if (timeUntilNote < -2) {
                // 画面外に出たノーツを削除
                noteElement.remove();
                this.activeNotes.delete(noteId);
            }
        });
    }

    addNewNotes(notes, currentTime) {
        notes.forEach((noteData, index) => {
            const timeUntilNote = noteData.time - currentTime;
            const noteId = `${noteData.note}_${noteData.time}_${index}`;
            
            // 新しいノーツで、表示範囲内の場合
            if (timeUntilNote > 0 && timeUntilNote <= this.options.lookAhead && !this.activeNotes.has(noteId)) {
                this.createVerticalNoteElement(noteData, timeUntilNote, index);
            }
        });
    }

    removeOffscreenNotes() {
        const containerHeight = this.container.clientHeight;
        
        this.activeNotes.forEach((noteElement, noteId) => {
            const rect = noteElement.getBoundingClientRect();
            
            // 画面下端より下に出たノーツを削除
            if (rect.top > containerHeight + 100) {
                noteElement.remove();
                this.activeNotes.delete(noteId);
            }
        });
    }

    checkHitTiming(notes, currentTime) {
        notes.forEach(noteData => {
            const timeUntilNote = noteData.time - currentTime;
            const noteId = `${noteData.note}_${noteData.time}`;
            
            // ヒットタイミングのチェック
            if (Math.abs(timeUntilNote) < 0.1) {
                this.highlightKey(noteData.note);
                
                // 自動演奏音を出す
                if (Math.abs(timeUntilNote) < 0.05 && !this.playedNotes.has(noteId)) {
                    // まだ演奏していないノートのみ処理
                    this.playedNotes.add(noteId);
                    this.playKeySound(noteData.note);
                    
                    // サーバーに1回だけ通知
                    this.syncCore.send({
                        type: 'note_played',
                        noteId: noteId,
                        clientType: this.clientType
                    });
                }
            }
        });
    }

    /**
     * 縦長ノーツ要素を作成（改良版）
     */
    createVerticalNoteElement(noteData, timeUntilNote, index) {
        const note = document.createElement('div');
        const isWhite = this.isWhiteKey(noteData.note);
        
        // ノーツの長さを音符の長さに基づいて計算
        const duration = noteData.duration || 0.5; // デフォルト0.5秒
        const calculatedHeight = Math.max(
            this.options.minNoteHeight,
            Math.min(
                this.options.maxNoteHeight,
                duration * this.options.noteHeightMultiplier
            )
        );
        
        note.className = `note ${this.clientType} ${isWhite ? 'white-key-note' : 'black-key-note'}`;
        note.dataset.noteId = `${noteData.note}_${noteData.time}_${index}`;
        note.dataset.noteHeight = calculatedHeight; // 高さをdata属性に保存
        
        // 位置計算
        const progress = (this.options.lookAhead - timeUntilNote) / this.options.lookAhead;
        const keyboardGuideRect = this.keyboardGuide.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();
        const keyboardTopRelative = keyboardGuideRect.top - containerRect.top;
        
        // 初期位置（画面上端より上から開始）
        const startPosition = -calculatedHeight - 100;
        const targetPosition = keyboardTopRelative - calculatedHeight;
        const totalDistance = targetPosition - startPosition;
        const topPosition = startPosition + (progress * totalDistance);
        
        const leftPosition = this.calculateNotePosition(noteData);
        
        // 縦長ノーツのスタイル設定
        const noteWidth = isWhite ? 36 : 22; // 白鍵/黒鍵に応じた幅
        note.style.cssText = `
            position: absolute;
            top: ${topPosition}px;
            left: ${leftPosition - (noteWidth / 2)}px;
            width: ${noteWidth}px;
            height: ${calculatedHeight}px;
            border-radius: 6px 6px 3px 3px;
            background: ${isWhite ? 
                'linear-gradient(180deg, #2196F3 0%, #1976D2 70%, #0D47A1 100%)' : 
                'linear-gradient(180deg, #FF6B35 0%, #D84315 70%, #BF360C 100%)'
            };
            color: white;
            display: flex;
            align-items: flex-end;
            justify-content: center;
            font-weight: bold;
            font-size: 11px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            z-index: 10;
            transition: transform 0.1s ease, box-shadow 0.1s ease;
            border: 2px solid rgba(255,255,255,0.4);
            padding-bottom: 4px;
            overflow: hidden;
        `;
        
        // ノート名表示
        const noteLabel = document.createElement('div');
        noteLabel.textContent = noteData.note.replace(/[0-9]/g, '');
        noteLabel.style.cssText = `
            background: rgba(0,0,0,0.3);
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 10px;
            margin-bottom: 2px;
        `;
        note.appendChild(noteLabel);
        
        // 指番号表示
        if (noteData.finger) {
            const fingerIndicator = document.createElement('div');
            fingerIndicator.textContent = noteData.finger;
            fingerIndicator.style.cssText = `
                position: absolute;
                top: 4px;
                right: 4px;
                width: 18px;
                height: 18px;
                background: rgba(255,255,255,0.95);
                color: #333;
                border-radius: 50%;
                font-size: 10px;
                font-weight: bold;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            `;
            note.appendChild(fingerIndicator);
        }
        
        // 音符の長さを視覚的に示すインジケーター
        if (calculatedHeight > 80) {
            const durationIndicator = document.createElement('div');
            durationIndicator.style.cssText = `
                position: absolute;
                top: 25px;
                left: 2px;
                right: 2px;
                height: ${calculatedHeight - 35}px;
                background: linear-gradient(180deg, 
                    rgba(255,255,255,0.2) 0%, 
                    rgba(255,255,255,0.1) 50%, 
                    rgba(255,255,255,0.05) 100%
                );
                border-radius: 2px;
                border: 1px solid rgba(255,255,255,0.1);
            `;
            note.appendChild(durationIndicator);
        }
        
        this.notesContainer.appendChild(note);
        this.activeNotes.set(note.dataset.noteId, note);
        
        // console.log(`✅ Created vertical note ${noteData.note}: height=${calculatedHeight}px, duration=${duration}s`);
    }

    isWhiteKey(noteName) {
        const baseNote = noteName.replace(/[0-9]/g, '');
        return ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(baseNote);
    }

    calculateNotePosition(noteData) {
        // positionプロパティがある場合はそれを使用
        if (noteData.position !== undefined) {
            return noteData.position;
        }

        // 88鍵対応のノートマッピング
        const keyPositions = this.generate88KeyPositions();
        const position = keyPositions[noteData.note];
        
        if (position !== undefined) {
            return position;
        }
        
        // フォールバック計算
        const noteMap = {
            'C': 100, 'C#': 115, 'Db': 115,
            'D': 140, 'D#': 155, 'Eb': 155,
            'E': 180,
            'F': 220, 'F#': 235, 'Gb': 235,
            'G': 260, 'G#': 275, 'Ab': 275,
            'A': 300, 'A#': 315, 'Bb': 315,
            'B': 340
        };
        
        const noteWithoutOctave = noteData.note.replace(/[0-9]/g, '');
        const basePosition = noteMap[noteWithoutOctave] || 200;
        
        const octave = parseInt(noteData.note.match(/\d/)?.[0] || '4');
        const octaveOffset = (octave - 4) * 280;
        
        return Math.max(50, Math.min(window.innerWidth - 100, basePosition + octaveOffset));
    }

    generate88KeyPositions() {
        const positions = {};
        const keyWidth = 28;
        const blackKeyWidth = 18;
        const startX = 50;
        let currentX = startX;

        // A0, A#0, B0
        positions['A0'] = currentX;
        currentX += keyWidth;
        positions['A#0'] = currentX - blackKeyWidth / 2;
        positions['B0'] = currentX;
        currentX += keyWidth;

        // C1からC8まで
        const notePattern = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

        for (let octave = 1; octave <= 8; octave++) {
            for (let i = 0; i < notePattern.length; i++) {
                const noteName = notePattern[i];
                const fullNote = `${noteName}${octave}`;
                
                if (whiteKeys.includes(noteName)) {
                    positions[fullNote] = currentX;
                    currentX += keyWidth;
                } else {
                    positions[fullNote] = currentX - keyWidth + (keyWidth - blackKeyWidth) / 2;
                }

                if (octave === 8 && noteName === 'C') {
                    break;
                }
            }
        }

        return positions;
    }

    highlightKey(noteName) {
        const key = this.keyboardGuide?.querySelector(`[data-note="${noteName}"]`);
        if (key) {
            key.classList.add('active');
            key.style.background = this.options.fallbackColor;
            
            setTimeout(() => {
                key.classList.remove('active');
                key.style.background = key.classList.contains('black') ? 
                    'linear-gradient(to bottom, #333, #111)' : 
                    'linear-gradient(to bottom, #ffffff, #f5f5f5)';
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
        if (this.notesContainer) {
            this.notesContainer.innerHTML = '';
        }
        this.activeNotes.clear();
        this.playedNotes.clear();
    }

    updateConnectionStatus(status, message) {
        if (!this.statusIndicator) return;
        
        const indicator = this.statusIndicator.querySelector('.status-indicator');
        const text = this.statusIndicator.querySelector('span:last-child');
        
        if (indicator) indicator.className = `status-indicator status-${status}`;
        if (text) text.textContent = message;
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
            
            if (latency > 50) {
                latencyText.style.color = '#ff9800';
            } else {
                latencyText.style.color = '';
            }
        }
    }

    handleKeyPress(key) {
        if (!key.dataset.note) return;
        
        key.style.transform = 'translateY(2px)';
        key.style.background = this.options.fallbackColor;
        
        setTimeout(() => {
            key.style.transform = '';
            key.style.background = key.classList.contains('black') ? 
                'linear-gradient(to bottom, #333, #111)' : 
                'linear-gradient(to bottom, #ffffff, #f5f5f5)';
        }, 150);
        
        this.playNoteSound(key.dataset.note);
    }

    playKeySound(noteName) {
        if (!this.syncCore.audioContext || this.syncCore.audioContext.state !== 'running') return;
        
        try {
            const midiNote = PianoSyncUtils.noteToMidi(noteName);
            if (!midiNote) return;
            
            const oscillator = this.syncCore.audioContext.createOscillator();
            const gainNode = this.syncCore.audioContext.createGainNode ? 
                              this.syncCore.audioContext.createGainNode() : 
                              this.syncCore.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.syncCore.audioContext.destination);
            
            const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);
            oscillator.frequency.value = frequency;
            oscillator.type = 'triangle';
            
            const now = this.syncCore.audioContext.currentTime;
            const gainValue = this.clientType === 'melody' ? 0.15 : 0.12;
            
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(gainValue, now + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
            
            oscillator.start(now);
            oscillator.stop(now + 0.8);
            
        } catch (error) {
            console.log('Sound play failed:', error);
        }
    }

    playNoteSound(noteName) {
        this.playKeySound(noteName);
    }

    handleResize() {
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

    destroy() {
        this.stopAnimation();
        this.clearNotes();
        
        if (this.syncCore) {
            this.syncCore.disconnect();
        }
    }
}

// PianoSyncUtils
class PianoSyncUtils {
    static noteToMidi(noteName) {
        const noteMap = {
            'C': 0, 'C#': 1, 'Db': 1,
            'D': 2, 'D#': 3, 'Eb': 3,
            'E': 4,
            'F': 5, 'F#': 6, 'Gb': 6,
            'G': 7, 'G#': 8, 'Ab': 8,
            'A': 9, 'A#': 10, 'Bb': 10,
            'B': 11
        };

        const match = noteName.match(/([A-G][#b]?)(\d+)/);
        if (!match) return null;

        const [, note, octave] = match;
        const noteValue = noteMap[note];
        if (noteValue === undefined) return null;

        return (parseInt(octave) + 1) * 12 + noteValue;
    }
}

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PianoClient;
} else {
    window.PianoClient = PianoClient;
    window.PianoSyncUtils = PianoSyncUtils;
}